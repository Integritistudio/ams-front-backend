const db = require('../config/database');
const Role = require('../models/Role');
const { canViewAll } = require('../middleware/permissions');
const { isSuperAdmin } = require('../services/permissionService');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');
const { requisitionDetails, requisitionVars } = require('../services/emailDetails');
const workflow = require('../services/requisitionWorkflow');
const routing = require('../services/approvalRouting');
const { REQ_STATUS, IT_QUEUE_STATUSES } = require('../services/workflowConstants');
const inventoryService = require('../services/inventoryService');
const fulfil = require('../services/fulfillmentRules');

const MAX_QUANTITY = 1000;

const { LIST_SELECT } = workflow;

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function roleLabel(req) {
  return req.authz?.role?.name || 'User';
}

function isItAdmin(req) {
  return Boolean(req.authz?.role?.is_it_admin);
}

function isExecutive(req) {
  return Boolean(req.authz?.role?.is_executive);
}

function isHrManager(req) {
  return Boolean(req.authz?.role?.is_hr_manager);
}

function isFinanceManager(req) {
  return Boolean(req.authz?.role?.is_finance_manager);
}

function isGm(req) {
  return Boolean(req.authz?.role?.is_gm);
}

function canSeeAllRequisitions(req) {
  return (
    isItAdmin(req) ||
    isExecutive(req) ||
    isHrManager(req) ||
    isGm(req) ||
    canViewAll('requisitions')(req) ||
    canViewAll('approvals')(req)
  );
}

async function findReq(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`${LIST_SELECT} WHERE req.id = $1`, [key])
    : await db.query(`${LIST_SELECT} WHERE req.public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function loadReplies(requisitionId) {
  const result = await db.query(
    `SELECT * FROM requisition_replies WHERE requisition_id = $1 ORDER BY created_at ASC`,
    [requisitionId]
  );
  return result.rows;
}

/** What the signed-in user can do on this row (drives buttons in the UI). */
function withWorkflow(req, row, ctx) {
  const access = workflow.stageAccessFor(req.authz, row, ctx);
  return {
    ...row,
    workflow: {
      stage: access.stage,
      action: access.action,
      can_act: access.canAct,
      can_reject: access.canReject,
    },
  };
}

async function linkedAssetCount(row) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS c FROM user_assets WHERE source_req_id = $1 OR source_req_public_id = $2`,
    [row.id, row.public_id]
  );
  return result.rows[0]?.c || 0;
}

async function withReplies(req, row, ctx) {
  if (!row) return null;
  const context = ctx || (await workflow.loadContext());
  const type = inventoryService.inventoryTypeFor(row.type);
  // Indicative stock is shown for hardware only — software licenses are checked manually by Admin/IT.
  const indicative = type === 'Hardware' ? await inventoryService.indicativeStock(row.item, type) : null;
  return {
    ...withWorkflow(req, row, context),
    replies: await loadReplies(row.id),
    indicative_stock: indicative,
    assigned_count: await linkedAssetCount(row),
    can_confirm_purchase: isItAdmin(req) && fulfil.checkConfirmPurchase(row).ok,
  };
}

function sendError(res, err) {
  return res.status(err.status).json({ success: false, message: err.message });
}

async function canAccessReq(req, row) {
  if (canSeeAllRequisitions(req)) return true;

  const userId = Number(req.authz.user.id);
  const email = (req.authz.user.email || '').toLowerCase();

  if ((row.requester_email || '').toLowerCase() === email) return true;
  if (row.requester_id && Number(row.requester_id) === userId) return true;

  // Line Manager: requests assigned to them
  if (row.line_manager_id && Number(row.line_manager_id) === userId) return true;
  // Legacy display field
  if (row.approver_id && Number(row.approver_id) === userId) return true;

  // Finance Manager: requests waiting on Finance
  if (isFinanceManager(req) && FINANCE_STATUSES.includes(row.status)) return true;

  // Price approver (any role configured as an approval tier): requests pending at their tier
  if (
    row.status === REQ_STATUS.PENDING_PRICE_APPROVAL &&
    row.approval_tier_role_id &&
    Number(row.approval_tier_role_id) === Number(req.authz?.role?.id)
  ) {
    return true;
  }

  return false;
}

const FINANCE_STATUSES = [REQ_STATUS.PENDING_FINANCE, REQ_STATUS.PENDING_FINANCE_PROCESSING];

async function list(req, res, next) {
  try {
    const userId = req.authz.user.id;
    const email = req.authz.user.email;
    let result;

    if (canSeeAllRequisitions(req)) {
      result = await db.query(`${LIST_SELECT} ORDER BY req.created_timestamp DESC`);
    } else {
      // Own requests + Line Manager queue + Finance queue + price approvals at the user's tier
      result = await db.query(
        `${LIST_SELECT}
         WHERE LOWER(req.requester_email) = LOWER($1)
            OR req.requester_id = $2
            OR req.line_manager_id = $2
            OR req.approver_id = $2
            OR ($3::boolean AND req.status = ANY($4::text[]))
            OR (req.status = $5 AND apt.role_id = $6)
         ORDER BY req.created_timestamp DESC`,
        [
          email,
          userId,
          isFinanceManager(req),
          FINANCE_STATUSES,
          REQ_STATUS.PENDING_PRICE_APPROVAL,
          req.authz?.role?.id || null,
        ]
      );
    }

    const ctx = await workflow.loadContext();
    return res.json({ success: true, data: result.rows.map((row) => withWorkflow(req, row, ctx)) });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }
    if (!(await canAccessReq(req, row))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    return res.json({ success: true, data: await withReplies(req, row) });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const {
      requester_name,
      requester_email,
      department,
      type,
      item,
      project,
      urgency,
      justification,
      attachment_url,
      on_behalf,
      quantity,
    } = req.body;

    if (isSuperAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Super Admin cannot create asset requests.' });
    }
    if (!type || !item) {
      return res.status(400).json({ success: false, message: 'type and item are required' });
    }
    const qty = quantity === undefined || quantity === null || quantity === '' ? 1 : Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      return res.status(400).json({ success: false, message: `quantity must be a whole number from 1 to ${MAX_QUANTITY}` });
    }
    if (!String(project || '').trim()) {
      return res.status(400).json({ success: false, message: 'project reference is required' });
    }

    const defaultName = req.authz.user.name;
    const defaultEmail = (req.authz.user.email || '').toLowerCase();
    const mayBehalf = canViewAll('requisitions')(req);
    const name = mayBehalf && requester_name ? requester_name : defaultName;
    const email = (mayBehalf && requester_email ? requester_email : defaultEmail).toLowerCase();
    const isBehalf = Boolean(on_behalf) && mayBehalf && email !== defaultEmail;

    let requesterId = req.authz.user.id;
    if (isBehalf) {
      const uRes = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [
        email,
      ]);
      if (uRes.rows[0]) requesterId = uRes.rows[0].id;
    }

    // Route by the requester's role (not the submitter's, for on-behalf requests).
    const requester = (await workflow.getRequesterProfile(requesterId)) || { id: requesterId };
    const skipLm = routing.skipsLineManager(requester);
    const lineManager = skipLm ? null : await workflow.getLineManager(requesterId);

    const urg = urgency || 'Standard';
    const pid = publicId('REQ');
    const today = new Date().toISOString().split('T')[0];
    const initialStatus = lineManager ? REQ_STATUS.PENDING_LINE_MANAGER : REQ_STATUS.PENDING_IT_INVENTORY;
    let skipReason = null;
    if (!lineManager) {
      if (requester.is_gm) skipReason = 'GM request';
      else if (requester.is_executive) skipReason = 'Executive request';
      else skipReason = 'no Line Manager configured';
    }
    const decisionHistory = skipReason
      ? `Submitted on ${today}. Line Manager approval skipped (${skipReason}). Sent to IT for inventory check.\n`
      : null;

    const inserted = await db.query(
      `INSERT INTO requisitions (
         public_id, requester_id, requester_name, requester_email, department,
         approver_id, approver_name, line_manager_id, type, item, project, urgency, justification,
         status, current_stage, attachment_url, decision_history, quantity
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        pid,
        requesterId,
        name,
        email,
        department || req.authz.user.department || null,
        lineManager ? lineManager.id : null,
        lineManager ? lineManager.name : null,
        lineManager ? lineManager.id : null,
        type,
        item,
        String(project).trim(),
        urg,
        justification || null,
        initialStatus,
        initialStatus,
        attachment_url || null,
        decisionHistory,
        qty,
      ]
    );

    const row = await workflow.findFresh(inserted.rows[0].id);
    const portal = workflow.portalBase();
    const ctx = await workflow.loadContext();

    if (lineManager) {
      await addAuditLog({
        user: actor(req),
        action: 'Submitted Requisition',
        details: isBehalf
          ? `Requisition ${row.public_id} submitted on behalf of ${name} to Line Manager ${lineManager.name}`
          : `Requisition ${row.public_id} forwarded to Line Manager ${lineManager.name}`,
        targetId: row.public_id,
      });

      await notifyUser({
        targetEmail: lineManager.email,
        name: lineManager.name,
        subject: `Pending Requisition ${row.public_id}`,
        title: 'Asset requisition needs your approval',
        text: `New asset requisition ${row.public_id} for "${row.item}" was submitted by ${name} and needs your Line Manager approval.`,
        type: 'warning',
        ctaLabel: 'Review approval',
        ctaUrl: `${portal}/approvals`,
        details: requisitionDetails(row),
        event: 'requisition.pending_approver',
        vars: requisitionVars(row),
      });

      await notifyUser({
        targetEmail: email,
        subject: `Requisition ${row.public_id} submitted`,
        title: 'Asset requisition submitted',
        text: `Your requisition ${row.public_id} for "${row.item}" was forwarded to ${lineManager.name} (Line Manager).`,
        type: 'info',
        ctaLabel: 'View requisition',
        ctaUrl: `${portal}/requisitions`,
        details: requisitionDetails(row),
        event: 'requisition.created',
        vars: requisitionVars(row),
      });
    } else {
      await workflow.addReply(
        row.id,
        'System',
        'System',
        `Line Manager approval skipped (${skipReason}). Sent to IT Admin for inventory check.`
      );

      await addAuditLog({
        user: actor(req),
        action: 'Submitted Requisition',
        details: `Requisition ${row.public_id} sent to IT inventory check (${skipReason})`,
        targetId: row.public_id,
      });

      await workflow.notifyInventoryCheck(row, ctx);

      await notifyUser({
        targetEmail: email,
        subject: `Requisition ${row.public_id} submitted`,
        title: 'Asset requisition submitted',
        text: `Your requisition ${row.public_id} for "${row.item}" was sent to IT Admin for an inventory check (${skipReason}).`,
        type: 'info',
        ctaLabel: 'View requisition',
        ctaUrl: `${portal}/requisitions`,
        details: requisitionDetails(row),
        event: 'requisition.created',
        vars: requisitionVars(row),
      });
    }

    return res.status(201).json({ success: true, data: await withReplies(req, row, ctx) });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }
    if (!(await canAccessReq(req, row))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const {
      department,
      type,
      item,
      project,
      urgency,
      justification,
      attachment_url,
      status,
      fulfillment_details,
      decision_history,
    } = req.body;

    // Workflow state only moves through the stage endpoints (approve / inventory-check / ...),
    // otherwise a requester could push their own request past approvals.
    if ((status !== undefined || decision_history !== undefined) && !isSuperAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Status and decision history can only be changed through the approval workflow.',
      });
    }

    const result = await db.query(
      `UPDATE requisitions SET
         department = COALESCE($2, department),
         type = COALESCE($3, type),
         item = COALESCE($4, item),
         project = COALESCE($5, project),
         urgency = COALESCE($6, urgency),
         justification = COALESCE($7, justification),
         attachment_url = COALESCE($8, attachment_url),
         status = COALESCE($9, status),
         current_stage = COALESCE($9, current_stage),
         fulfillment_details = COALESCE($10, fulfillment_details),
         decision_history = COALESCE($11, decision_history),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        row.id,
        department,
        type,
        item,
        project,
        urgency,
        justification,
        attachment_url,
        status,
        fulfillment_details ? JSON.stringify(fulfillment_details) : null,
        decision_history,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Updated Requisition',
      details: `Updated requisition ${row.public_id}`,
      targetId: row.public_id,
    });

    return res.json({ success: true, data: await withReplies(req, await findReq(row.id)) });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }
    if (!canViewAll('requisitions')(req)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    await db.query(`DELETE FROM requisitions WHERE id = $1`, [row.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Requisition',
      details: `Deleted requisition ${row.public_id}`,
      targetId: row.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

/**
 * Load the request and check the signed-in user may perform `action` at its current stage.
 * Returns { row, ctx, access } or sends the error response and returns null.
 */
async function gateAction(req, res, action) {
  const row = await findReq(req.params.id);
  if (!row) {
    res.status(404).json({ success: false, message: 'Requisition not found' });
    return null;
  }
  const ctx = await workflow.loadContext();
  const access = workflow.stageAccessFor(req.authz, row, ctx);
  if (!access.canAct) {
    res.status(403).json({ success: false, message: access.message || 'Access denied' });
    return null;
  }
  if (access.action !== action) {
    res.status(400).json({
      success: false,
      message: `This stage expects the "${ACTION_ENDPOINTS[access.action]}" action.`,
    });
    return null;
  }
  return { row, ctx, access };
}

const ACTION_ENDPOINTS = {
  approve: 'approve',
  inventory_check: 'inventory-check',
  pricing: 'submit-pricing',
  finance_process: 'finance-process',
};

async function approve(req, res, next) {
  try {
    const gate = await gateAction(req, res, 'approve');
    if (!gate) return undefined;
    const { row, ctx, access } = gate;
    const actorUser = actor(req);
    let updated;

    switch (access.stage) {
      case 'line_manager':
        updated = await workflow.afterLineManagerApprove(row, actorUser, ctx);
        break;
      case 'hr':
        updated = await workflow.afterHrApprove(row, actorUser);
        break;
      case 'price_approval':
        updated = await workflow.afterPriceApprove(row, actorUser);
        break;
      case 'legacy_finance':
        updated = await workflow.afterLegacyFinanceApprove(row, actorUser);
        break;
      case 'legacy_gm':
        updated = await workflow.afterLegacyGmApprove(row, actorUser);
        break;
      case 'legacy_executive':
        updated = await workflow.afterLegacyExecutiveApprove(row, actorUser);
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Request is not awaiting an approval decision.',
        });
    }

    await addAuditLog({
      user: actorUser,
      action: 'Approved Requisition',
      details: `Approved ${row.public_id} at stage ${access.stage}; status → ${updated.status}`,
      targetId: row.public_id,
    });

    return res.json({ success: true, data: await withReplies(req, updated, ctx) });
  } catch (err) {
    if (err.status) return sendError(res, err);
    return next(err);
  }
}

async function reject(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }

    const ctx = await workflow.loadContext();
    const access = workflow.stageAccessFor(req.authz, row, ctx);
    if (!access.canAct) {
      return res.status(403).json({ success: false, message: access.message || 'Access denied' });
    }
    if (!access.canReject) {
      return res.status(403).json({
        success: false,
        message: 'Rejection is not allowed at this stage.',
      });
    }

    const reason = req.body.reason || 'Rejected';
    const today = new Date().toISOString().split('T')[0];
    const history = `${row.decision_history || ''}Rejected by ${req.authz.user.name} on ${today}: ${reason}\n`;

    const updated = await workflow.setStatus(row.id, REQ_STATUS.REJECTED, {
      decision_history: history,
      from_status: row.status,
    });

    await workflow.addReply(
      row.id,
      req.authz.user.name,
      roleLabel(req),
      `Rejected: ${reason}`
    );

    await addAuditLog({
      user: actor(req),
      action: 'Rejected Requisition',
      details: `Rejected ${row.public_id} at stage ${access.stage}: ${reason}`,
      targetId: row.public_id,
    });

    await workflow.notifyRequester(
      updated,
      `Rejected Requisition ${row.public_id}`,
      `Your requisition ${row.public_id} was rejected by ${req.authz.user.name}: ${reason}`,
      'error',
      {
        title: 'Requisition rejected',
        details: requisitionDetails(updated, {
          actionedBy: req.authz.user.name,
          rejectReason: reason,
          status: REQ_STATUS.REJECTED,
        }),
        event: 'requisition.rejected',
        vars: requisitionVars(updated, {
          actionedBy: req.authz.user.name,
          rejectReason: reason,
          status: REQ_STATUS.REJECTED,
        }),
      }
    );

    return res.json({ success: true, data: await withReplies(req, updated, ctx) });
  } catch (err) {
    if (err.status) return sendError(res, err);
    return next(err);
  }
}

/**
 * IT Admin confirms whether the requested item is in stock.
 * Body: { available: boolean, note? }
 */
async function inventoryCheck(req, res, next) {
  try {
    const { available, note } = req.body || {};
    if (typeof available !== 'boolean') {
      return res.status(400).json({ success: false, message: 'available (true/false) is required' });
    }
    const gate = await gateAction(req, res, 'inventory_check');
    if (!gate) return undefined;
    const { row, ctx } = gate;

    const updated = await workflow.recordInventoryCheck(row, actor(req), { available, note }, ctx);

    await addAuditLog({
      user: actor(req),
      action: 'Requisition Inventory Check',
      details: `${row.public_id}: ${available ? 'in stock' : 'not in stock'}; status → ${updated.status}`,
      targetId: row.public_id,
    });

    return res.json({ success: true, data: await withReplies(req, updated, ctx) });
  } catch (err) {
    if (err.status) return sendError(res, err);
    return next(err);
  }
}

function positiveAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

/**
 * IT Admin submits the initial price when the item must be procured.
 * Body: { total_price, vendor_quotes? }
 */
async function submitPricing(req, res, next) {
  try {
    const { total_price, vendor_quotes } = req.body || {};
    const price = positiveAmount(total_price);
    if (price === null) {
      return res.status(400).json({ success: false, message: 'total_price must be a positive number' });
    }
    const gate = await gateAction(req, res, 'pricing');
    if (!gate) return undefined;
    const { row, ctx } = gate;

    const updated = await workflow.submitPricing(row, actor(req), { total_price: price, vendor_quotes }, ctx);

    await addAuditLog({
      user: actor(req),
      action: 'Submitted Requisition Pricing',
      details: `Submitted initial price for ${row.public_id}: ${price}; status → ${updated.status}`,
      targetId: row.public_id,
    });

    return res.json({ success: true, data: await withReplies(req, updated, ctx) });
  } catch (err) {
    if (err.status) return sendError(res, err);
    return next(err);
  }
}

/**
 * Finance records the vendor quotation and payment for an approved procurement.
 * Body: { quote_amount, vendor?, invoice_ref?, payment_ref?, notes? }
 * A quotation above the approved price is routed back for re-approval.
 */
async function financeProcess(req, res, next) {
  try {
    const body = req.body || {};
    const quote = positiveAmount(body.quote_amount);
    if (quote === null) {
      return res.status(400).json({ success: false, message: 'quote_amount must be a positive number' });
    }
    const gate = await gateAction(req, res, 'finance_process');
    if (!gate) return undefined;
    const { row, ctx } = gate;

    const updated = await workflow.processFinance(row, actor(req), { ...body, quote_amount: quote }, ctx);
    const reapproval = updated.status !== REQ_STATUS.SENT_TO_IT;

    await addAuditLog({
      user: actor(req),
      action: reapproval ? 'Requisition Quotation Re-approval' : 'Requisition Finance Processed',
      details: reapproval
        ? `${row.public_id}: vendor quotation ${quote} exceeds approved ${row.approved_amount}; status → ${updated.status}`
        : `${row.public_id}: vendor quotation ${quote} processed and paid; sent to IT`,
      targetId: row.public_id,
    });

    return res.json({ success: true, data: await withReplies(req, updated, ctx) });
  } catch (err) {
    if (err.status) return sendError(res, err);
    return next(err);
  }
}

async function hold(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }
    if (!isItAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only IT Admin can put asset requests on hold or resume them',
      });
    }

    const { status } = req.body;
    const reason = req.body.reason || req.body.hold_reason || req.body.holdReason;
    const nextStatus = status || (row.status === REQ_STATUS.ON_HOLD ? REQ_STATUS.IN_PROGRESS : REQ_STATUS.ON_HOLD);
    const holdReason = nextStatus === REQ_STATUS.ON_HOLD ? reason || row.hold_reason : null;

    if (nextStatus === REQ_STATUS.ON_HOLD && !holdReason) {
      return res.status(400).json({ success: false, message: 'reason is required when placing on hold' });
    }

    if (nextStatus === REQ_STATUS.ON_HOLD && !IT_QUEUE_STATUSES.includes(row.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot hold a request with status "${row.status}"`,
      });
    }

    const result = await db.query(
      `UPDATE requisitions SET
         status = $2,
         current_stage = $2,
         hold_reason = $3,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [row.id, nextStatus, holdReason]
    );

    const replyText =
      nextStatus === REQ_STATUS.ON_HOLD
        ? `[ASSET REQUEST ON HOLD] Reason: ${holdReason}`
        : 'IT Admin resumed work on asset request from hold status.';

    await workflow.addReply(row.id, req.authz.user.name, roleLabel(req), replyText);

    await addAuditLog({
      user: actor(req),
      action: nextStatus === REQ_STATUS.ON_HOLD ? 'Requisition On Hold' : 'Resumed Requisition',
      details: replyText,
      targetId: row.public_id,
    });

    await notifyUser({
      targetEmail: row.requester_email,
      subject: `Requisition ${row.public_id}: ${nextStatus}`,
      title: `Requisition ${nextStatus}`,
      text: replyText,
      type: nextStatus === REQ_STATUS.ON_HOLD ? 'warning' : 'info',
      ctaLabel: 'View requisition',
      ctaUrl: `${workflow.portalBase()}/requisitions`,
      details: requisitionDetails(result.rows[0] || row, {
        status: nextStatus,
        holdReason: nextStatus === REQ_STATUS.ON_HOLD ? holdReason : null,
        actionedBy: req.authz.user.name,
        replyText,
      }),
      event: 'requisition.status_changed',
      vars: requisitionVars(result.rows[0] || row, {
        status: nextStatus,
        holdReason: nextStatus === REQ_STATUS.ON_HOLD ? holdReason : null,
        actionedBy: req.authz.user.name,
        replyText,
      }),
    });

    return res.json({ success: true, data: await withReplies(req, await findReq(row.id)) });
  } catch (err) {
    return next(err);
  }
}

async function assertItAdminAction(req, row, actionLabel) {
  if (!isItAdmin(req)) {
    const err = new Error(`Only IT Admin can ${actionLabel} asset requests`);
    err.status = 403;
    throw err;
  }
  if (!IT_QUEUE_STATUSES.includes(row.status)) {
    const err = new Error(
      `Cannot ${actionLabel} a request with status "${row.status}". It must be approved and sent to IT first.`
    );
    err.status = 400;
    throw err;
  }
}

async function setReqStatus(req, res, next, status, replyText, holdReason) {
  const row = await findReq(req.params.id);
  if (!row) {
    return res.status(404).json({ success: false, message: 'Requisition not found' });
  }
  try {
    await assertItAdminAction(req, row, `set status to ${status}`);
  } catch (denied) {
    if (denied.status) {
      return res.status(denied.status).json({ success: false, message: denied.message });
    }
    throw denied;
  }

  const result = await db.query(
    `UPDATE requisitions SET
       status = $2,
       current_stage = $2,
       hold_reason = $3,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [row.id, status, holdReason === undefined ? row.hold_reason : holdReason]
  );

  if (replyText) {
    await workflow.addReply(row.id, req.authz.user.name, roleLabel(req), replyText);
  }

  await addAuditLog({
    user: actor(req),
    action: `Requisition ${status}`,
    details: replyText || `Requisition ${row.public_id} set to ${status}`,
    targetId: row.public_id,
  });

  await notifyUser({
    targetEmail: row.requester_email,
    subject: `Requisition ${row.public_id}: ${status}`,
    title: `Asset request status: ${status}`,
    text: replyText || `Your asset request ${row.public_id} status is now ${status}.`,
    type: status === REQ_STATUS.COMPLETED ? 'success' : status === REQ_STATUS.ON_HOLD ? 'warning' : 'info',
    ctaLabel: 'View requisition',
    ctaUrl: `${workflow.portalBase()}/requisitions`,
    details: requisitionDetails(result.rows[0] || row, {
      status,
      holdReason: holdReason === undefined ? row.hold_reason : holdReason,
      actionedBy: req.authz.user.name,
      replyText,
    }),
    event: 'requisition.status_changed',
    vars: requisitionVars(result.rows[0] || row, {
      status,
      holdReason:
        typeof holdReason !== 'undefined'
          ? holdReason === undefined
            ? row.hold_reason
            : holdReason
          : undefined,
      actionedBy: req.authz.user.name,
      replyText,
    }),
  });

  if (status === REQ_STATUS.COMPLETED && (row.approver_id || row.line_manager_id)) {
    const notifyId = row.line_manager_id || row.approver_id;
    const approverRes = await db.query(
      `SELECT email, name FROM users WHERE id = $1 AND status = 'Active' LIMIT 1`,
      [notifyId]
    );
    const approver = approverRes.rows[0];
    if (
      approver?.email &&
      (approver.email || '').toLowerCase() !== (row.requester_email || '').toLowerCase()
    ) {
      await notifyUser({
        targetEmail: approver.email,
        subject: `Completed Requisition ${row.public_id}`,
        title: 'Asset request completed',
        text: `Asset request ${row.public_id} for "${row.item}" (requested by ${row.requester_name}) has been marked Completed by IT.`,
        type: 'success',
        ctaLabel: 'View asset requests',
        ctaUrl: `${workflow.portalBase()}/requisitions`,
        name: approver.name,
        details: requisitionDetails(result.rows[0] || row, {
          status: REQ_STATUS.COMPLETED,
          actionedBy: req.authz.user.name,
          replyText,
        }),
        event: 'requisition.status_changed',
        vars: requisitionVars(result.rows[0] || row, {
          status,
          actionedBy: req.authz.user.name,
          replyText,
        }),
      });
    }
  }

  return res.json({ success: true, data: await withReplies(req, await findReq(row.id)) });
}

async function inProgress(req, res, next) {
  try {
    return await setReqStatus(
      req,
      res,
      next,
      REQ_STATUS.IN_PROGRESS,
      'IT Admin marked asset request In Progress and is actively working on it.',
      null
    );
  } catch (err) {
    return next(err);
  }
}

async function resume(req, res, next) {
  try {
    return await setReqStatus(
      req,
      res,
      next,
      REQ_STATUS.IN_PROGRESS,
      'IT Admin resumed work on asset request from hold status.',
      null
    );
  } catch (err) {
    return next(err);
  }
}

async function complete(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }

    if (!isItAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only IT Admin can complete asset requests' });
    }
    const assigned = await linkedAssetCount(row);
    const check = fulfil.checkComplete(row, assigned);
    if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

    const body = req.body || {};
    const note = body.note || body.resolution || 'Asset request marked completed';
    return await setReqStatus(
      req,
      res,
      next,
      REQ_STATUS.COMPLETED,
      `Asset request marked completed: ${note}`,
      null
    );
  } catch (err) {
    return next(err);
  }
}

function text(value) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  return s || null;
}

/** Date the purchase was finally approved: last approval-chain step, else Finance payment date. */
function approvalDate(row) {
  const chain = Array.isArray(row.approval_chain) ? row.approval_chain : [];
  const stamps = chain.map((s) => s.at).filter(Boolean).sort();
  const at = stamps[stamps.length - 1] || row.finance_details?.paid_at || null;
  return at ? String(at).slice(0, 10) : null;
}

/**
 * Admin/IT verified the delivered hardware / activated license → Confirm Purchase.
 * In one transaction: add the stock to inventory, create the procurement log (linked to the request and
 * the inventory item) and mark the request purchase-confirmed. This is the only path that registers
 * purchased stock for a request.
 * Body: { quantity?, inventory_item_id?, item_name?, brand?, serial_number?, vendor?, cost?,
 *         delivery_date?, location?, notes? }
 */
async function confirmPurchase(req, res, next) {
  let client;
  try {
    if (!isItAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only IT Admin can confirm purchases' });
    }
    const row = await findReq(req.params.id);
    const check = fulfil.checkConfirmPurchase(row);
    if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

    const body = req.body || {};
    const qty = body.quantity === undefined || body.quantity === '' ? fulfil.requestedQuantity(row) : Number(body.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      return res.status(400).json({ success: false, message: `quantity must be a whole number from 1 to ${MAX_QUANTITY}` });
    }
    const type = inventoryService.inventoryTypeFor(row.type);
    const finance = row.finance_details || {};
    const itemName = text(body.item_name) || row.item;
    const vendor = text(body.vendor) || finance.vendor || null;
    const cost = text(body.cost) || (finance.quote_amount != null ? String(finance.quote_amount) : row.approved_amount != null ? String(row.approved_amount) : null);
    const deliveryDate = text(body.delivery_date) || new Date().toISOString().split('T')[0];
    const by = req.authz.user;

    client = await db.getClient();
    await client.query('BEGIN');

    const item = await inventoryService.addStock(client, {
      inventoryItemId: body.inventory_item_id || null,
      name: itemName,
      type,
      qty,
      location: text(body.location),
    });

    const log = await client.query(
      `INSERT INTO procurement_logs (
         public_id, source_req_id, item_name, vendor, cost, brand, serial_number,
         approval_date, delivery_date, approver, assigned_user_email, department,
         description, status, inventory_item_id, quantity, confirmed_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Purchase Confirmed',$14,$15,$16)
       RETURNING *`,
      [
        publicId('PROC'),
        row.id,
        item.name,
        vendor,
        cost,
        text(body.brand),
        text(body.serial_number),
        approvalDate(row),
        deliveryDate,
        row.approver_name || null,
        (row.requester_email || '').toLowerCase() || null,
        row.department || null,
        text(body.notes) || `Confirmed purchase for request ${row.public_id}`,
        item.id,
        qty,
        by.id,
      ]
    );
    const procurement = log.rows[0];

    const marked = await client.query(
      `UPDATE requisitions SET
         purchase_confirmed_at = NOW(),
         purchase_confirmed_by = $2,
         procurement_log_id = $3,
         inventory_item_id = $4,
         status = $5,
         current_stage = $5,
         decision_history = COALESCE(decision_history, '') || $6,
         updated_at = NOW()
       WHERE id = $1 AND purchase_confirmed_at IS NULL AND status = $7
       RETURNING id`,
      [
        row.id,
        by.id,
        procurement.id,
        item.id,
        REQ_STATUS.IN_PROGRESS,
        `Purchase confirmed by ${by.name} on ${deliveryDate}: ${qty} × ${item.name} added to inventory (${item.public_id}); procurement log ${procurement.public_id}.\n`,
        row.status,
      ]
    );
    if (!marked.rows[0]) {
      await client.query('ROLLBACK');
      client.release();
      client = null;
      return res.status(409).json({ success: false, message: 'This request was already updated. Refresh and try again.' });
    }
    await client.query('COMMIT');
    client.release();
    client = null;

    const note = `Purchase confirmed: ${qty} × ${item.name} received and added to inventory (${item.public_id}). Procurement log ${procurement.public_id}. Ready to assign.`;
    await workflow.addReply(row.id, by.name, roleLabel(req), note);
    await addAuditLog({
      user: actor(req),
      action: 'Confirmed Purchase',
      details: `${row.public_id}: procurement log ${procurement.public_id}; inventory ${item.public_id} +${qty} (${type}); available now ${item.quantity_available}`,
      targetId: row.public_id,
    });
    const fresh = await findReq(row.id);
    await workflow.notifyRequester(
      fresh,
      `Request ${row.public_id} — purchase confirmed`,
      `IT received "${item.name}" for your request ${row.public_id}. It will be assigned to you shortly.`,
      'info'
    );
    return res.json({ success: true, data: await withReplies(req, fresh) });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    if (err.status) return sendError(res, err);
    return next(err);
  }
}

async function reply(req, res, next) {
  try {
    const { text } = req.body;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ success: false, message: 'text is required' });
    }
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }
    if (!(await canAccessReq(req, row))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    await workflow.addReply(row.id, req.authz.user.name, roleLabel(req), text.trim());

    await addAuditLog({
      user: actor(req),
      action: 'Requisition Comment',
      details: `Posted query on ${row.public_id}`,
      targetId: row.public_id,
    });

    if (
      (row.requester_email || '').toLowerCase() !==
      (req.authz.user.email || '').toLowerCase()
    ) {
      await notifyUser({
        targetEmail: row.requester_email,
        subject: `Reply on Requisition ${row.public_id}`,
        title: 'New reply on your requisition',
        text: `${req.authz.user.name} replied on requisition ${row.public_id}: ${text.trim()}`,
        type: 'info',
        ctaLabel: 'View requisition',
        ctaUrl: `${workflow.portalBase()}/requisitions`,
        details: requisitionDetails(row, {
          repliedBy: req.authz.user.name,
          replyMessage: text.trim(),
        }),
        event: 'requisition.reply',
        vars: requisitionVars(row, {
          repliedBy: req.authz.user.name,
          replyMessage: text.trim(),
        }),
      });
    }

    return res.json({ success: true, data: await withReplies(req, row) });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  approve,
  reject,
  inventoryCheck,
  submitPricing,
  financeProcess,
  hold,
  inProgress,
  resume,
  complete,
  confirmPurchase,
  reply,
};
