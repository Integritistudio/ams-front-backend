const db = require('../config/database');
const Role = require('../models/Role');
const inventoryService = require('./inventoryService');
const { getApprovalLimits } = require('./permissionService');
const { REQ_STATUS } = require('./workflowConstants');
const { notifyUser } = require('./notifyService');
const { requisitionDetails, requisitionVars } = require('./emailDetails');

function portalBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
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

async function setStatus(reqId, status, extra = {}) {
  const sets = ['status = $2', 'current_stage = $2', 'updated_at = NOW()'];
  const params = [reqId, status];
  let i = 3;
  if (extra.total_price !== undefined) {
    sets.push(`total_price = $${i++}`);
    params.push(extra.total_price);
  }
  if (extra.inventory_available !== undefined) {
    sets.push(`inventory_available = $${i++}`);
    params.push(extra.inventory_available);
  }
  if (extra.vendor_quotes !== undefined) {
    sets.push(`vendor_quotes = $${i++}`);
    params.push(JSON.stringify(extra.vendor_quotes));
  }
  if (extra.approver_id !== undefined) {
    sets.push(`approver_id = $${i++}`);
    params.push(extra.approver_id);
  }
  if (extra.approver_name !== undefined) {
    sets.push(`approver_name = $${i++}`);
    params.push(extra.approver_name);
  }
  if (extra.due_timestamp !== undefined) {
    sets.push(`due_timestamp = $${i++}`);
    params.push(extra.due_timestamp);
  }
  if (extra.decision_history !== undefined) {
    sets.push(`decision_history = $${i++}`);
    params.push(extra.decision_history);
  }
  const result = await db.query(
    `UPDATE requisitions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return result.rows[0];
}

async function notifyRoleFlag(flag, subject, text, type, extra = {}) {
  const users = await Role.findUsersWithFlag(flag);
  for (const u of users) {
    if (!u.email) continue;
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
  }
  return users;
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
    event: extra.event || null,
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

/**
 * After LM approve: inventory check → HR or IT pricing.
 * Price may be null until IT pricing; HR limit uses total_price or 0.
 */
async function afterLineManagerApprove(row, actor) {
  const available = await inventoryService.isItemAvailable(row.item);
  const today = new Date().toISOString().split('T')[0];
  const details = requisitionDetails(row, { actionedBy: actor.name });

  if (available) {
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_HR, {
      inventory_available: true,
      decision_history:
        `${row.decision_history || ''}Approved by Line Manager ${actor.name} on ${today}. Inventory available → HR.\n`,
    });
    await addReply(
      row.id,
      'System',
      'System',
      `Line Manager approved. Inventory available for "${row.item}". Routed to HR Manager.`
    );
    await routeToHrOrEscalate(updated, actor, { skipNotifyIfAuto: false });
    return findFresh(row.id);
  }

  const updated = await setStatus(row.id, REQ_STATUS.PENDING_IT_PRICING, {
    inventory_available: false,
    decision_history:
      `${row.decision_history || ''}Approved by Line Manager ${actor.name} on ${today}. Inventory unavailable → IT pricing.\n`,
  });
  await addReply(
    row.id,
    'System',
    'System',
    `Line Manager approved. Item not in inventory. IT Admin must submit vendor pricing.`
  );
  await notifyRoleFlag(
    'is_it_admin',
    `Pricing needed — ${row.public_id}`,
    `Request ${row.public_id} for "${row.item}" needs vendor pricing (no stock).`,
    'warning',
    { details, event: 'requisition.pricing_needed', vars: requisitionVars(updated) }
  );
  await notifyRequester(
    updated,
    `Request ${row.public_id} — pending IT pricing`,
    `Your Line Manager approved ${row.public_id}. IT is gathering vendor pricing because the item is not in stock.`,
    'info',
    { details, event: 'requisition.approved', vars: requisitionVars(updated) }
  );
  return updated;
}

/**
 * Route to HR if within limit, else auto-approve HR and go to GM.
 */
async function routeToHrOrEscalate(row, actor, { skipNotifyIfAuto } = {}) {
  const limits = await getApprovalLimits();
  const price = Number(row.total_price ?? 0);
  const details = requisitionDetails(row);

  if (price > Number(limits.hr_approval_limit)) {
    const today = new Date().toISOString().split('T')[0];
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_GM, {
      decision_history:
        `${row.decision_history || ''}[AUTO] HR skipped — price ${price} exceeds HR limit ${limits.hr_approval_limit} on ${today}. Routed to GM.\n`,
    });
    await addReply(
      row.id,
      'System',
      'System',
      `Price ${price} exceeds HR limit (${limits.hr_approval_limit}). Auto-escalated to GM.`
    );
    await notifyRoleFlag(
      'is_gm',
      `GM approval needed — ${row.public_id}`,
      `Request ${row.public_id} (${row.item}) exceeds HR limit and needs GM approval. Price: ${price}.`,
      'warning',
      { details, event: 'requisition.pending_gm', vars: requisitionVars(updated) }
    );
    if (!skipNotifyIfAuto) {
      await notifyRequester(
        updated,
        `Request ${row.public_id} escalated to GM`,
        `Request ${row.public_id} was auto-escalated past HR (price above HR limit). Awaiting GM.`,
        'info',
        { details, vars: requisitionVars(updated) }
      );
    }
    return updated;
  }

  const updated = await setStatus(row.id, REQ_STATUS.PENDING_HR, {
    decision_history: row.decision_history,
  });
  await notifyRoleFlag(
    'is_hr_manager',
    `HR approval needed — ${row.public_id}`,
    `Request ${row.public_id} for "${row.item}" awaits HR approval. Price: ${price || 'N/A'}.`,
    'warning',
    { details, event: 'requisition.pending_hr', vars: requisitionVars(updated) }
  );
  return updated;
}

async function afterFinanceApprove(row, actor) {
  const today = new Date().toISOString().split('T')[0];
  let updated = await setStatus(row.id, REQ_STATUS.PENDING_HR, {
    decision_history:
      `${row.decision_history || ''}Finance approved by ${actor.name} on ${today}.\n`,
  });
  await addReply(row.id, actor.name, 'Finance Manager', 'Finance approved vendor pricing.');
  updated = await routeToHrOrEscalate(updated, actor);
  return findFresh(row.id);
}

async function afterHrApprove(row, actor) {
  const hours = row.urgency === 'Urgent' ? 48 : 120;
  const due = new Date(Date.now() + hours * 60 * 60 * 1000);
  const today = new Date().toISOString().split('T')[0];
  const updated = await setStatus(row.id, REQ_STATUS.SENT_TO_IT, {
    due_timestamp: due,
    decision_history:
      `${row.decision_history || ''}HR approved by ${actor.name} on ${today}. Sent to IT (${hours}h SLA).\n`,
  });
  await addReply(row.id, actor.name, 'HR Manager', `Approved. Forwarded to IT (${hours}h SLA).`);
  await notifyItFinal(updated, actor);
  await notifyRequester(
    updated,
    `Approved — ${row.public_id}`,
    `Your request ${row.public_id} was approved by HR and sent to IT for fulfillment.`,
    'success',
    { event: 'requisition.approved', vars: requisitionVars(updated) }
  );
  return updated;
}

async function afterGmApprove(row, actor) {
  const limits = await getApprovalLimits();
  const price = Number(row.total_price ?? 0);
  const today = new Date().toISOString().split('T')[0];
  const hours = row.urgency === 'Urgent' ? 48 : 120;

  if (price > Number(limits.gm_approval_limit)) {
    const updated = await setStatus(row.id, REQ_STATUS.PENDING_EXECUTIVE, {
      decision_history:
        `${row.decision_history || ''}GM approved by ${actor.name} on ${today}. Price ${price} exceeds GM limit ${limits.gm_approval_limit} → Executive.\n`,
    });
    await addReply(
      row.id,
      actor.name,
      'GM',
      `Approved. Price exceeds GM limit — routed to Executive.`
    );
    await notifyRoleFlag(
      'is_executive',
      `Executive approval needed — ${row.public_id}`,
      `Request ${row.public_id} exceeds GM limit and needs Executive approval. Price: ${price}.`,
      'warning',
      { details: requisitionDetails(updated), vars: requisitionVars(updated) }
    );
    return updated;
  }

  const due = new Date(Date.now() + hours * 60 * 60 * 1000);
  const updated = await setStatus(row.id, REQ_STATUS.SENT_TO_IT, {
    due_timestamp: due,
    decision_history:
      `${row.decision_history || ''}GM approved by ${actor.name} on ${today}. Within GM limit → IT (${hours}h SLA).\n`,
  });
  await addReply(row.id, actor.name, 'GM', `Approved. Sent to IT (${hours}h SLA).`);
  await notifyItFinal(updated, actor);
  await notifyRequester(
    updated,
    `Approved — ${row.public_id}`,
    `Your request ${row.public_id} was approved by GM and sent to IT.`,
    'success',
    { event: 'requisition.approved', vars: requisitionVars(updated) }
  );
  return updated;
}

async function afterExecutiveApprove(row, actor) {
  const hours = row.urgency === 'Urgent' ? 48 : 120;
  const due = new Date(Date.now() + hours * 60 * 60 * 1000);
  const today = new Date().toISOString().split('T')[0];
  const updated = await setStatus(row.id, REQ_STATUS.SENT_TO_IT, {
    due_timestamp: due,
    decision_history:
      `${row.decision_history || ''}Executive approved by ${actor.name} on ${today}. Sent to IT (${hours}h SLA).\n`,
  });
  await addReply(row.id, actor.name, 'Executive', `Approved. Sent to IT (${hours}h SLA).`);
  await notifyItFinal(updated, actor);
  await notifyRequester(
    updated,
    `Approved — ${row.public_id}`,
    `Your request ${row.public_id} was approved by Executive and sent to IT.`,
    'success',
    { event: 'requisition.approved', vars: requisitionVars(updated) }
  );
  return updated;
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

async function findFresh(id) {
  const result = await db.query(`SELECT * FROM requisitions WHERE id = $1`, [id]);
  return result.rows[0];
}

/**
 * Who may act on the current status.
 * Returns { ok, canReject, stage } or { ok: false, message }.
 */
function canActOnStage(req, row) {
  const role = req.authz?.role || {};
  const userId = Number(req.authz?.user?.id);
  const status = row.status;

  if (status === REQ_STATUS.PENDING_LINE_MANAGER || status === 'Pending Manager Approval') {
    const isLm = row.line_manager_id && Number(row.line_manager_id) === userId;
    if (isLm) {
      return { ok: true, canReject: true, stage: 'line_manager' };
    }
    return { ok: false, message: 'Only the Line Manager can act on this request.' };
  }

  if (status === REQ_STATUS.PENDING_IT_PRICING) {
    if (role.is_it_admin) return { ok: true, canReject: false, stage: 'it_pricing' };
    return { ok: false, message: 'Only IT Admin can submit pricing.' };
  }

  if (status === REQ_STATUS.PENDING_FINANCE) {
    if (role.is_finance_manager) return { ok: true, canReject: true, stage: 'finance' };
    return { ok: false, message: 'Only Finance Manager can act at this stage.' };
  }

  if (status === REQ_STATUS.PENDING_HR) {
    if (role.is_hr_manager) return { ok: true, canReject: true, stage: 'hr' };
    return { ok: false, message: 'Only HR Manager can act at this stage.' };
  }

  if (status === REQ_STATUS.PENDING_GM) {
    if (role.is_gm) return { ok: true, canReject: true, stage: 'gm' };
    // Executive override while pending GM
    if (role.is_executive) return { ok: true, canReject: true, stage: 'executive_override' };
    return { ok: false, message: 'Only GM or Executive can act at this stage.' };
  }

  if (status === REQ_STATUS.PENDING_EXECUTIVE) {
    if (role.is_executive) return { ok: true, canReject: true, stage: 'executive' };
    return { ok: false, message: 'Only Executive can act at this stage.' };
  }

  return { ok: false, message: 'Request is not awaiting an approval decision.' };
}

module.exports = {
  REQ_STATUS,
  getLineManager,
  afterLineManagerApprove,
  afterFinanceApprove,
  afterHrApprove,
  afterGmApprove,
  afterExecutiveApprove,
  routeToHrOrEscalate,
  canActOnStage,
  setStatus,
  appendHistory,
  addReply,
  notifyRoleFlag,
  notifyRequester,
  notifyItFinal,
  findFresh,
  portalBase,
};
