const db = require('../config/database');
const Role = require('../models/Role');
const tierService = require('./approvalTierService');
const routing = require('./approvalRouting');
const { getApprovalLimits } = require('./permissionService');
const { REQ_STATUS } = require('./workflowConstants');
const { notifyUser } = require('./notifyService');
const { requisitionDetails, requisitionVars } = require('./emailDetails');

const REQ_SLA = { Urgent: 48, Standard: 120 };

/** Requisition row + requester role flags + current approval tier (used for routing and access checks). */
const LIST_SELECT = `
  SELECT req.*,
         ru.role_id AS requester_role_id,
         COALESCE(rr.is_it_admin, FALSE) AS requester_is_it_admin,
         COALESCE(rr.is_executive, FALSE) AS requester_is_executive,
         COALESCE(rr.is_hr_manager, FALSE) AS requester_is_hr_manager,
         COALESCE(rr.is_finance_manager, FALSE) AS requester_is_finance_manager,
         COALESCE(rr.is_gm, FALSE) AS requester_is_gm,
         apt.role_id AS approval_tier_role_id,
         tr.name AS approval_tier_role_name,
         apt.max_amount AS approval_tier_max_amount,
         lm.name AS line_manager_name
  FROM requisitions req
  LEFT JOIN users ru ON ru.id = req.requester_id
  LEFT JOIN roles rr ON rr.id = ru.role_id
  LEFT JOIN approval_tiers apt ON apt.id = req.approval_tier_id
  LEFT JOIN roles tr ON tr.id = apt.role_id
  LEFT JOIN users lm ON lm.id = req.line_manager_id
`;

function portalBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function slaHours(urgency) {
  return REQ_SLA[urgency] || REQ_SLA.Standard;
}

function withHistory(row, line) {
  return `${row.decision_history || ''}${line.endsWith('\n') ? line : `${line}\n`}`;
}

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function requesterFromRow(row) {
  return {
    id: row.requester_id,
    role_id: row.requester_role_id,
    is_it_admin: Boolean(row.requester_is_it_admin),
    is_hr_manager: Boolean(row.requester_is_hr_manager),
    is_finance_manager: Boolean(row.requester_is_finance_manager),
    is_gm: Boolean(row.requester_is_gm),
    is_executive: Boolean(row.requester_is_executive),
  };
}

/** Active tiers + IT Admin users — everything stage access checks need. */
async function loadContext() {
  const [tiers, itAdmins] = await Promise.all([
    tierService.listTiers({ activeOnly: true }),
    Role.findUsersWithFlag('is_it_admin'),
  ]);
  return { tiers, itAdmins, itAdminIds: itAdmins.map((u) => Number(u.id)) };
}

async function getRequesterProfile(userId) {
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.role_id,
            COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
            COALESCE(r.is_hr_manager, FALSE) AS is_hr_manager,
            COALESCE(r.is_finance_manager, FALSE) AS is_finance_manager,
            COALESCE(r.is_gm, FALSE) AS is_gm,
            COALESCE(r.is_executive, FALSE) AS is_executive
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function appendHistory(reqId, line) {
  await db.query(
    `UPDATE requisitions SET
       decision_history = COALESCE(decision_history, '') || $2,
       updated_at = NOW()
     WHERE id = $1`,
    [reqId, line.endsWith('\n') ? line : `${line}\n`]
  );
}

async function addReply(reqId, author, roleLabel, text) {
  await db.query(
    `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
     VALUES ($1, $2, $3, $4)`,
    [reqId, author, roleLabel, text]
  );
}

const SETTABLE_COLUMNS = [
  'total_price',
  'inventory_available',
  'vendor_quotes',
  'approver_id',
  'approver_name',
  'due_timestamp',
  'decision_history',
  'approval_tier_id',
  'approved_amount',
  'finance_details',
  'inventory_checked_by',
  'inventory_checked_at',
];
const JSON_COLUMNS = new Set(['vendor_quotes', 'finance_details']);

/**
 * Move a request to `status`, updating whitelisted columns from `extra`.
 * With `extra.from_status`, the update only applies if the request is still at that status
 * (guards against two approvers acting at once) and throws 409 otherwise.
 */
async function setStatus(reqId, status, extra = {}) {
  const sets = ['status = $2', 'current_stage = $2', 'updated_at = NOW()'];
  const params = [reqId, status];
  for (const col of SETTABLE_COLUMNS) {
    if (extra[col] === undefined) continue;
    params.push(JSON_COLUMNS.has(col) && extra[col] !== null ? JSON.stringify(extra[col]) : extra[col]);
    sets.push(`${col} = $${params.length}`);
  }
  let where = 'id = $1';
  if (extra.from_status) {
    params.push(extra.from_status);
    where += ` AND status = $${params.length}`;
  }
  const result = await db.query(
    `UPDATE requisitions SET ${sets.join(', ')} WHERE ${where} RETURNING id`,
    params
  );
  if (!result.rows[0]) {
    if (extra.from_status) throw conflict('This request was already actioned by someone else. Refresh and try again.');
    return null;
  }
  return findFresh(reqId);
}

async function notifyUsers(users, subject, text, type, extra = {}) {
  const exclude = new Set((extra.excludeIds || []).map(Number));
  const seen = new Set();
  const notified = [];
  for (const u of users || []) {
    if (!u?.email || exclude.has(Number(u.id))) continue;
    const key = String(u.email).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    await notifyUser({
      targetEmail: u.email,
      name: u.name,
      subject,
      title: extra.title || subject,
      text,
      type: type || 'warning',
      ctaLabel: extra.ctaLabel || 'Open pending approvals',
      ctaUrl: extra.ctaUrl || `${portalBase()}/approvals`,
      details: extra.details || [],
      event: extra.event || null,
      vars: extra.vars || {},
    });
    notified.push(u);
  }
  return notified;
}

async function notifyRoleFlag(flag, subject, text, type, extra = {}) {
  const users = await Role.findUsersWithFlag(flag);
  return notifyUsers(users, subject, text, type, extra);
}

async function usersWithRole(roleId) {
  const result = await db.query(
    `SELECT id, name, email FROM users WHERE role_id = $1 AND status = 'Active' ORDER BY name ASC`,
    [roleId]
  );
  return result.rows;
}

async function superAdmins() {
  const result = await db.query(
    `SELECT id, name, email FROM users WHERE is_super_admin = TRUE AND status = 'Active'`
  );
  return result.rows;
}

async function notifyRequester(row, subject, text, type, extra = {}) {
  if (!row.requester_email) return;
  await notifyUser({
    targetEmail: row.requester_email,
    name: row.requester_name,
    subject,
    title: extra.title || subject,
    text,
    type: type || 'info',
    ctaLabel: extra.ctaLabel || 'View request',
    ctaUrl: extra.ctaUrl || `${portalBase()}/requisitions`,
    details: extra.details || requisitionDetails(row),
    event: extra.event || 'requisition.status_changed',
    vars: extra.vars || requisitionVars(row),
  });
}

async function getLineManager(userId) {
  const result = await db.query(
    `SELECT m.id, m.name, m.email, m.status
     FROM users u
     JOIN users m ON m.id = u.manager_id
     WHERE u.id = $1 AND m.status = 'Active'`,
    [userId]
  );
  return result.rows[0] || null;
}

/** IT Admins who may verify this request: everyone except the requester, unless they are the only one. */
function itHandlersFor(row, ctx) {
  const lone = routing.isLoneItAdmin(requesterFromRow(row), ctx.itAdminIds);
  return ctx.itAdmins.filter((u) => lone || Number(u.id) !== Number(row.requester_id));
}

async function notifyInventoryCheck(row, ctx) {
  await notifyUsers(
    itHandlersFor(row, ctx),
    `Inventory check needed — ${row.public_id}`,
    `Request ${row.public_id} for "${row.item}" (requested by ${row.requester_name}) needs an inventory check.`,
    'warning',
    {
      details: requisitionDetails(row),
      event: 'requisition.pending_inventory',
      vars: requisitionVars(row),
    }
  );
}

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

/** Line Manager approved → IT inventory check (verification is never skipped). */
async function afterLineManagerApprove(row, actor, ctx) {
  const updated = await setStatus(row.id, REQ_STATUS.PENDING_IT_INVENTORY, {
    approver_id: actor.id,
    approver_name: actor.name,
    decision_history: withHistory(
      row,
      `Approved by Line Manager ${actor.name} on ${today()}. Sent to IT for inventory check.`
    ),
    from_status: row.status,
  });
  await addReply(row.id, actor.name, 'Line Manager', 'Approved. Sent to IT Admin for inventory check.');
  await notifyInventoryCheck(updated, ctx);
  await notifyRequester(
    updated,
    `Request ${row.public_id} — approved by Line Manager`,
    `Your Line Manager ${actor.name} approved ${row.public_id}. IT Admin is now checking inventory.`,
    'info',
    { details: requisitionDetails(updated, { actionedBy: actor.name }) }
  );
  return updated;
}

function inStockHrSkipReason(requester, lone) {
  if (requester.is_hr_manager) return 'requester is HR Manager';
  if (requester.is_gm) return 'requester is GM';
  if (requester.is_executive) return 'requester is Executive';
  if (lone) return 'requester is the only IT Admin; Line Manager approval applies';
  return null;
}

/** IT Admin confirms inventory: in stock → HR (or straight to delivery), not in stock → IT pricing. */
async function recordInventoryCheck(row, actor, { available, note }, ctx) {
  const requester = requesterFromRow(row);
  const lone = routing.isLoneItAdmin(requester, ctx.itAdminIds);
  const noteText = note ? ` Note: ${note}` : '';
  const checked = {
    inventory_available: Boolean(available),
    inventory_checked_by: actor.id,
    inventory_checked_at: new Date(),
    from_status: REQ_STATUS.PENDING_IT_INVENTORY,
  };

  if (available) {
    if (routing.skipsInStockHr(requester, { loneItAdmin: lone })) {
      const reason = inStockHrSkipReason(requester, lone);
      return sendToIt(row, actor, {
        extra: checked,
        roleLabel: 'IT Admin',
        history: `Inventory confirmed in stock by ${actor.name} on ${today()}. HR approval skipped (${reason}).`,
        reply: `Inventory confirmed: in stock. HR approval skipped (${reason}). Ready for delivery.${noteText}`,
        requesterText: `IT confirmed "${row.item}" is in stock. Your request ${row.public_id} is ready for delivery.`,
      });
    }

    const updated = await setStatus(row.id, REQ_STATUS.PENDING_HR, {
      ...checked,
      decision_history: withHistory(
        row,
        `Inventory confirmed in stock by ${actor.name} on ${today()}. Sent to HR for approval.`
      ),
    });
    await addReply(row.id, actor.name, 'IT Admin', `Inventory confirmed: in stock. Sent to HR for approval.${noteText}`);
    await notifyRoleFlag(
      'is_hr_manager',
      `HR approval needed — ${row.public_id}`,
      `Request ${row.public_id} for "${row.item}" (in stock) awaits HR approval.`,
      'warning',
      {
        details: requisitionDetails(updated, { actionedBy: actor.name }),
        event: 'requisition.pending_hr',
        vars: requisitionVars(updated),
        excludeIds: [row.requester_id],
      }
    );
    await notifyRequester(
      updated,
      `Request ${row.public_id} — pending HR`,
      `IT confirmed "${row.item}" is in stock. Your request ${row.public_id} now awaits HR approval.`,
      'info'
    );
    return updated;
  }

  const updated = await setStatus(row.id, REQ_STATUS.PENDING_IT_PRICING, {
    ...checked,
    decision_history: withHistory(
      row,
      `Inventory checked by ${actor.name} on ${today()}: not in stock. Procurement required — IT to submit initial price.`
    ),
  });
  await addReply(
    row.id,
    actor.name,
    'IT Admin',
    `Inventory checked: not in stock. Procurement required — initial price to follow.${noteText}`
  );
  await notifyRequester(
    updated,
    `Request ${row.public_id} — procurement required`,
    `"${row.item}" is not in stock. IT is getting an initial price so the purchase can be approved.`,
    'info'
  );
  return updated;
}

/**
 * Route a procurement amount to the matching approval tier.
 * Used after IT initial pricing and again when the vendor quotation exceeds the approved price.
 */
async function routePriceApproval(row, amount, actor, ctx, { history, fromStatus, extra = {}, reapproval = false }) {
  const decision = routing.resolvePriceApproval(ctx.tiers, amount, { role_id: row.requester_role_id });
  const label = reapproval ? 'Re-approval' : 'Approval';

  if (decision.kind === 'auto') {
    const { tier } = decision;
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_FINANCE_PROCESSING, {
      ...extra,
      total_price: amount,
      approved_amount: amount,
      approval_tier_id: tier.id,
      approver_id: row.requester_id,
      approver_name: `${row.requester_name} (Auto-approved — ${tier.role_name})`,
      decision_history: withHistory(
        row,
        `${history}\n[AUTO] Price ${amount} auto-approved within ${tier.role_name} limit (requester holds this approval role). Sent to Finance.`
      ),
      from_status: fromStatus,
    });
    await addReply(
      row.id,
      'System',
      'System',
      `Price ${amount} auto-approved (requester is ${tier.role_name}, within limit). Sent to Finance for quotation and payment.`
    );
    await notifyRoleFlag(
      'is_hr_manager',
      `For information — ${row.public_id} auto-approved`,
      `Request ${row.public_id} for "${row.item}" by ${row.requester_name} was auto-approved at ${amount} (${tier.role_name} limit). No action needed.`,
      'info',
      {
        details: requisitionDetails(updated),
        event: 'requisition.price_info',
        vars: requisitionVars(updated),
        excludeIds: [row.requester_id],
        ctaLabel: 'View request',
        ctaUrl: `${portalBase()}/requisitions`,
      }
    );
    await notifyFinance(updated);
    return updated;
  }

  if (decision.kind === 'tier') {
    const { tier, requesterMayAct } = decision;
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_PRICE_APPROVAL, {
      ...extra,
      total_price: amount,
      approval_tier_id: tier.id,
      approver_id: null,
      approver_name: tier.role_name,
      decision_history: withHistory(row, `${history}\n${label} of ${amount} routed to ${tier.role_name}.`),
      from_status: fromStatus,
    });
    await addReply(row.id, 'System', 'System', `${label} of price ${amount} routed to ${tier.role_name}.`);

    const approvers = await usersWithRole(tier.role_id);
    const notified = await notifyUsers(
      approvers,
      `Price approval needed — ${row.public_id}`,
      `Request ${row.public_id} for "${row.item}" needs ${reapproval ? 're-' : ''}approval at ${amount}.`,
      'warning',
      {
        details: requisitionDetails(updated),
        event: 'requisition.pending_price_approval',
        vars: requisitionVars(updated),
        excludeIds: requesterMayAct ? [] : [row.requester_id],
      }
    );
    // HR is always informed of the procurement price, even when a higher tier approves it.
    if (!tier.role_is_hr_manager) {
      await notifyRoleFlag(
        'is_hr_manager',
        `For information — ${row.public_id} price ${amount}`,
        `Request ${row.public_id} for "${row.item}" is priced at ${amount}, above the HR limit. Routed to ${tier.role_name} for approval.`,
        'info',
        {
          details: requisitionDetails(updated),
          event: 'requisition.price_info',
          vars: requisitionVars(updated),
          excludeIds: [row.requester_id, ...notified.map((u) => u.id)],
          ctaLabel: 'View request',
          ctaUrl: `${portalBase()}/requisitions`,
        }
      );
    }
    await notifyRequester(
      updated,
      `Request ${row.public_id} — pending ${tier.role_name} approval`,
      `Your request ${row.public_id} is priced at ${amount} and awaits ${tier.role_name} approval.`,
      'info'
    );
    return updated;
  }

  // No tier covers this amount — Super Admin must act (or fix approval tiers).
  const updated = await setStatus(row.id, REQ_STATUS.PENDING_PRICE_APPROVAL, {
    ...extra,
    total_price: amount,
    approval_tier_id: null,
    approver_id: null,
    approver_name: 'Super Admin (no approval tier configured)',
    decision_history: withHistory(
      row,
      `${history}\nNo approval tier covers ${amount}. Waiting for Super Admin.`
    ),
    from_status: fromStatus,
  });
  await addReply(row.id, 'System', 'System', `No approval tier covers ${amount}. Super Admin action required.`);
  await notifyUsers(
    await superAdmins(),
    `Approval tier missing — ${row.public_id}`,
    `Request ${row.public_id} (${amount}) has no approval tier that covers its amount. Approve/reject it or update approval tiers in Settings.`,
    'error',
    { details: requisitionDetails(updated), event: 'requisition.pending_price_approval', vars: requisitionVars(updated) }
  );
  return updated;
}

/** IT Admin submits the initial price for a procurement request. */
async function submitPricing(row, actor, { total_price, vendor_quotes }, ctx) {
  const price = Number(total_price);
  return routePriceApproval(row, price, actor, ctx, {
    history: `Initial price ${price} submitted by IT Admin ${actor.name} on ${today()}.`,
    fromStatus: REQ_STATUS.PENDING_IT_PRICING,
    extra: vendor_quotes !== undefined ? { vendor_quotes } : {},
  });
}

/** Price approver (HR / GM / Executive / any configured tier) approved → Finance processing. */
async function afterPriceApprove(row, actor) {
  const updated = await setStatus(row.id, REQ_STATUS.PENDING_FINANCE_PROCESSING, {
    approved_amount: row.total_price,
    approver_id: actor.id,
    approver_name: actor.name,
    decision_history: withHistory(
      row,
      `Price ${row.total_price} approved by ${actor.name} (${row.approval_tier_role_name || 'Super Admin'}) on ${today()}. Sent to Finance.`
    ),
    from_status: REQ_STATUS.PENDING_PRICE_APPROVAL,
  });
  await addReply(
    row.id,
    actor.name,
    row.approval_tier_role_name || 'Approver',
    `Approved price ${row.total_price}. Sent to Finance for vendor quotation and payment.`
  );
  await notifyFinance(updated);
  await notifyRequester(
    updated,
    `Request ${row.public_id} — price approved`,
    `${actor.name} approved ${row.public_id} at ${row.total_price}. Finance will now get the vendor quotation and pay.`,
    'info',
    { details: requisitionDetails(updated, { actionedBy: actor.name }), event: 'requisition.approved' }
  );
  return updated;
}

async function notifyFinance(row) {
  await notifyRoleFlag(
    'is_finance_manager',
    `Finance processing needed — ${row.public_id}`,
    `Request ${row.public_id} for "${row.item}" is approved at ${row.approved_amount}. Please get the vendor quotation and process payment.`,
    'warning',
    {
      details: requisitionDetails(row),
      event: 'requisition.pending_finance_processing',
      vars: requisitionVars(row),
    }
  );
}

/**
 * Finance records the vendor quotation and payment.
 * Quotation above the approved price → re-approval at the new amount; otherwise → IT for delivery.
 */
async function processFinance(row, actor, body, ctx) {
  const quote = Number(body.quote_amount);
  const approved = Number(row.approved_amount);
  const previous = row.finance_details || {};
  const entry = {
    quote_amount: quote,
    vendor: body.vendor || null,
    invoice_ref: body.invoice_ref || null,
    payment_ref: body.payment_ref || null,
    notes: body.notes || null,
    by: actor.name,
    at: new Date().toISOString(),
  };
  const details = { ...previous, ...entry, quotes: [...(previous.quotes || []), entry] };

  if (quote > approved) {
    return routePriceApproval(row, quote, actor, ctx, {
      history: `Finance (${actor.name}) vendor quotation ${quote} exceeds approved price ${approved} on ${today()}.`,
      fromStatus: REQ_STATUS.PENDING_FINANCE_PROCESSING,
      extra: { finance_details: details },
      reapproval: true,
    });
  }

  return sendToIt(row, actor, {
    extra: {
      finance_details: { ...details, paid_at: entry.at },
      from_status: REQ_STATUS.PENDING_FINANCE_PROCESSING,
    },
    roleLabel: 'Finance Manager',
    history: `Finance ${actor.name} processed vendor quotation ${quote}${entry.vendor ? ` (${entry.vendor})` : ''} and payment on ${today()}. Sent to IT for delivery.`,
    reply: `Vendor quotation ${quote} processed and paid${entry.vendor ? ` (${entry.vendor})` : ''}. Sent to IT Admin for delivery.`,
    requesterText: `Finance processed the purchase for ${row.public_id}. IT Admin will deliver "${row.item}".`,
  });
}

/** Hand over to IT for fulfilment / delivery with SLA. */
async function sendToIt(row, actor, { extra = {}, roleLabel, history, reply, requesterText }) {
  const hours = slaHours(row.urgency);
  const updated = await setStatus(row.id, REQ_STATUS.SENT_TO_IT, {
    ...extra,
    due_timestamp: new Date(Date.now() + hours * 60 * 60 * 1000),
    decision_history: withHistory(row, `${history} (${hours}h SLA)`),
    from_status: extra.from_status || row.status,
  });
  await addReply(row.id, actor.name, roleLabel, reply);
  await notifyItFinal(updated, actor);
  await notifyRequester(updated, `Approved — ${row.public_id}`, requesterText, 'success', {
    event: 'requisition.approved',
    vars: requisitionVars(updated, { actionedBy: actor.name, slaHours: hours }),
  });
  return updated;
}

/** HR approved an in-stock request → IT delivers. */
async function afterHrApprove(row, actor) {
  return sendToIt(row, actor, {
    roleLabel: 'HR Manager',
    history: `HR approved by ${actor.name} on ${today()}. Sent to IT.`,
    reply: 'Approved. Forwarded to IT for delivery.',
    requesterText: `Your request ${row.public_id} was approved by HR and sent to IT for fulfillment.`,
  });
}

async function notifyItFinal(row, actor) {
  await notifyRoleFlag(
    'is_it_admin',
    `Action required — ${row.public_id}`,
    `${actor.name} approved ${row.public_id} ("${row.item}"). Please fulfill under Pending Approvals (assign or procure).`,
    'warning',
    {
      details: requisitionDetails(row, { actionedBy: actor.name }),
      event: 'requisition.approved_it',
      vars: requisitionVars(row),
    }
  );
}

// ---------------------------------------------------------------------------
// Legacy stages — only for requests created before the requester-based workflow
// ---------------------------------------------------------------------------

/** Legacy: route to HR if within limit, else GM. */
async function routeToHrOrEscalate(row) {
  const limits = await getApprovalLimits();
  const price = Number(row.total_price ?? 0);
  const details = requisitionDetails(row);

  if (price > Number(limits.hr_approval_limit)) {
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_GM, {
      decision_history: withHistory(
        row,
        `[AUTO] HR skipped — price ${price} exceeds HR limit ${limits.hr_approval_limit} on ${today()}. Routed to GM.`
      ),
    });
    await addReply(row.id, 'System', 'System', `Price ${price} exceeds HR limit (${limits.hr_approval_limit}). Auto-escalated to GM.`);
    await notifyRoleFlag(
      'is_gm',
      `GM approval needed — ${row.public_id}`,
      `Request ${row.public_id} (${row.item}) exceeds HR limit and needs GM approval. Price: ${price}.`,
      'warning',
      { details, event: 'requisition.pending_gm', vars: requisitionVars(updated) }
    );
    return updated;
  }

  const updated = await setStatus(row.id, REQ_STATUS.PENDING_HR, {});
  await notifyRoleFlag(
    'is_hr_manager',
    `HR approval needed — ${row.public_id}`,
    `Request ${row.public_id} for "${row.item}" awaits HR approval. Price: ${price || 'N/A'}.`,
    'warning',
    { details, event: 'requisition.pending_hr', vars: requisitionVars(updated) }
  );
  return updated;
}

async function afterLegacyFinanceApprove(row, actor) {
  const updated = await setStatus(row.id, REQ_STATUS.PENDING_HR, {
    decision_history: withHistory(row, `Finance approved by ${actor.name} on ${today()}.`),
    from_status: REQ_STATUS.PENDING_FINANCE,
  });
  await addReply(row.id, actor.name, 'Finance Manager', 'Finance approved vendor pricing.');
  return routeToHrOrEscalate(updated);
}

async function afterLegacyGmApprove(row, actor) {
  const limits = await getApprovalLimits();
  const price = Number(row.total_price ?? 0);

  if (price > Number(limits.gm_approval_limit)) {
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_EXECUTIVE, {
      decision_history: withHistory(
        row,
        `GM approved by ${actor.name} on ${today()}. Price ${price} exceeds GM limit ${limits.gm_approval_limit} → Executive.`
      ),
      from_status: REQ_STATUS.PENDING_GM,
    });
    await addReply(row.id, actor.name, 'GM', 'Approved. Price exceeds GM limit — routed to Executive.');
    await notifyRoleFlag(
      'is_executive',
      `Executive approval needed — ${row.public_id}`,
      `Request ${row.public_id} exceeds GM limit and needs Executive approval. Price: ${price}.`,
      'warning',
      { details: requisitionDetails(updated), vars: requisitionVars(updated) }
    );
    return updated;
  }

  return sendToIt(row, actor, {
    roleLabel: 'GM',
    history: `GM approved by ${actor.name} on ${today()}. Within GM limit → IT.`,
    reply: 'Approved. Sent to IT.',
    requesterText: `Your request ${row.public_id} was approved by GM and sent to IT.`,
  });
}

async function afterLegacyExecutiveApprove(row, actor) {
  return sendToIt(row, actor, {
    roleLabel: 'Executive',
    history: `Executive approved by ${actor.name} on ${today()}. Sent to IT.`,
    reply: 'Approved. Sent to IT.',
    requesterText: `Your request ${row.public_id} was approved by Executive and sent to IT.`,
  });
}

async function findFresh(id) {
  const result = await db.query(`${LIST_SELECT} WHERE req.id = $1`, [id]);
  return result.rows[0];
}

/** Stage access for the signed-in user (req.authz) on a row. */
function stageAccessFor(authz, row, ctx) {
  const user = {
    id: authz?.user?.id,
    role: authz?.role || {},
    is_super_admin: Boolean(authz?.is_super_admin || authz?.user?.is_super_admin),
  };
  return routing.getStageAccess(user, row, ctx);
}

module.exports = {
  REQ_STATUS,
  LIST_SELECT,
  slaHours,
  loadContext,
  getRequesterProfile,
  getLineManager,
  notifyInventoryCheck,
  afterLineManagerApprove,
  recordInventoryCheck,
  submitPricing,
  afterPriceApprove,
  processFinance,
  afterHrApprove,
  afterLegacyFinanceApprove,
  afterLegacyGmApprove,
  afterLegacyExecutiveApprove,
  stageAccessFor,
  setStatus,
  appendHistory,
  addReply,
  notifyRoleFlag,
  notifyRequester,
  notifyItFinal,
  findFresh,
  portalBase,
};
