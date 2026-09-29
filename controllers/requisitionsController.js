const db = require('../config/database');
const Role = require('../models/Role');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser, notifyMany } = require('../services/notifyService');
const { requisitionDetails, requisitionVars } = require('../services/emailDetails');
const workflow = require('../services/requisitionWorkflow');
const inventoryService = require('../services/inventoryService');
const { REQ_STATUS, IT_QUEUE_STATUSES } = require('../services/workflowConstants');

const REQ_SLA = { Urgent: 48, Standard: 120 };

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function roleLabel(req) {
  return req.authz?.role?.name || 'User';
}

function slaHours(urgency) {
  return REQ_SLA[urgency] || REQ_SLA.Standard;
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

/** Exclusive role flags other than Executive (blocks Executive auto-path to IT). */
function hasExclusiveNonExecutive(role = {}) {
  return Boolean(
    role.is_it_admin ||
      role.is_hr_manager ||
      role.is_finance_manager ||
      role.is_gm
  );
}

/** Executive-only (no other exclusive flag): skip LM → send straight to IT. */
function isExecutiveAutoPath(req) {
  return isExecutive(req) && !hasExclusiveNonExecutive(req.authz?.role || {});
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

async function withReplies(row) {
  if (!row) return null;
  return { ...row, replies: await loadReplies(row.id) };
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

  // Finance Manager: Pending Finance, or all if view_all
  if (isFinanceManager(req)) {
    if (canViewAll('requisitions')(req) || canViewAll('approvals')(req)) return true;
    if (row.status === REQ_STATUS.PENDING_FINANCE) return true;
  }

  return false;
}

const LIST_SELECT = `
  SELECT req.*,
         COALESCE(rr.is_executive, FALSE) AS requester_is_executive,
         COALESCE(rr.is_hr_manager, FALSE) AS requester_is_hr_manager,
         COALESCE(rr.is_finance_manager, FALSE) AS requester_is_finance_manager,
         COALESCE(rr.is_gm, FALSE) AS requester_is_gm
  FROM requisitions req
  LEFT JOIN users ru ON ru.id = req.requester_id
  LEFT JOIN roles rr ON rr.id = ru.role_id
`;

async function notifyModuleUsers(moduleSlug, subject, text, type = 'info', extra = {}) {
  const result = await db.query(
    `SELECT DISTINCT u.email
     FROM users u
     JOIN role_permissions rp ON rp.role_id = u.role_id
     JOIN modules m ON m.id = rp.module_id
     WHERE m.slug = $1 AND u.status = 'Active' AND m.is_active = TRUE`,
    [moduleSlug]
  );
  const exclude = new Set(
    (extra.excludeEmails || []).map((e) => String(e || '').toLowerCase()).filter(Boolean)
  );
  const emails = result.rows
    .map((r) => r.email)
    .filter((email) => email && !exclude.has(String(email).toLowerCase()));
  await notifyMany(emails, {
    subject,
    title: extra.title || subject,
    text,
    type,
    ctaLabel: extra.ctaLabel,
    ctaUrl: extra.ctaUrl,
    details: extra.details || [],
    event: extra.event || null,
    vars: extra.vars || {},
  });
}

async function list(req, res, next) {
  try {
    const userId = req.authz.user.id;
    const email = req.authz.user.email;
    let result;

    if (canSeeAllRequisitions(req)) {
      result = await db.query(`${LIST_SELECT} ORDER BY req.created_timestamp DESC`);
    } else if (isFinanceManager(req)) {
      // Own + Pending Finance (need to approve). Full list if view_all already handled above.
      result = await db.query(
        `${LIST_SELECT}
         WHERE LOWER(req.requester_email) = LOWER($1)
            OR req.requester_id = $2
            OR req.status = $3
         ORDER BY req.created_timestamp DESC`,
        [email, userId, REQ_STATUS.PENDING_FINANCE]
      );
    } else {
      // Line Manager: own + where line_manager_id = self; Staff: own (same query covers both)
      result = await db.query(
        `${LIST_SELECT}
         WHERE LOWER(req.requester_email) = LOWER($1)
            OR req.requester_id = $2
            OR req.line_manager_id = $2
            OR req.approver_id = $2
         ORDER BY req.created_timestamp DESC`,
        [email, userId]
      );
    }

    return res.json({ success: true, data: result.rows });
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
    return res.json({ success: true, data: await withReplies(row) });
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
    } = req.body;

    if (!type || !item) {
      return res.status(400).json({ success: false, message: 'type and item are required' });
    }
    if (!String(project || '').trim()) {
      return res.status(400).json({ success: false, message: 'project reference is required' });
    }

    const executiveDirectToIt = isExecutiveAutoPath(req);

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

    let lineManager = null;
    if (!executiveDirectToIt) {
      lineManager = await workflow.getLineManager(requesterId);
      if (!lineManager) {
        return res.status(400).json({
          success: false,
          message:
            'No Line Manager configured. Set manager_id on the requester user before submitting asset requests.',
        });
      }
    }

    const urg = urgency || 'Standard';
    const pid = publicId('REQ');
    const today = new Date().toISOString().split('T')[0];
    const hours = slaHours(urg);

    let initialStatus = REQ_STATUS.PENDING_LINE_MANAGER;
    let dueTimestamp = null;
    let decisionHistory = null;
    let storedApproverId = lineManager ? lineManager.id : null;
    let storedApproverName = lineManager ? lineManager.name : null;
    let storedLineManagerId = lineManager ? lineManager.id : null;
    let inventoryAvailable = null;

    if (executiveDirectToIt) {
      initialStatus = REQ_STATUS.SENT_TO_IT;
      dueTimestamp = new Date(Date.now() + hours * 60 * 60 * 1000);
      inventoryAvailable = await inventoryService.isItemAvailable(item);
      decisionHistory =
        `[EXECUTIVE_PRIORITY] Auto-approved by Executive ${req.authz.user.name} on ${today}. ` +
        `Line Manager approval skipped — sent directly to IT Admin with ${hours}h SLA. ` +
        `Inventory: ${inventoryAvailable ? 'Available in Inventory' : 'Need Purchase'}.\n`;
      storedApproverId = req.authz.user.id;
      storedApproverName = `${req.authz.user.name} (Executive Auto-Approved)`;
      storedLineManagerId = null;
    }

    const result = await db.query(
      `INSERT INTO requisitions (
         public_id, requester_id, requester_name, requester_email, department,
         approver_id, approver_name, line_manager_id, type, item, project, urgency, justification,
         status, current_stage, attachment_url, due_timestamp, decision_history, inventory_available
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        pid,
        requesterId,
        name,
        email,
        department || req.authz.user.department || null,
        storedApproverId,
        storedApproverName,
        storedLineManagerId,
        type,
        item,
        String(project).trim(),
        urg,
        justification || null,
        initialStatus,
        initialStatus,
        attachment_url || null,
        dueTimestamp,
        decisionHistory,
        inventoryAvailable,
      ]
    );

    const row = result.rows[0];
    const portal = workflow.portalBase();

    if (executiveDirectToIt) {
      await workflow.addReply(
        row.id,
        'System',
        'System',
        `[EXECUTIVE PRIORITY] Auto-approved by Executive ${req.authz.user.name}. Sent directly to IT Admin (${hours}h SLA).`
      );

      await addAuditLog({
        user: actor(req),
        action: 'Submitted Requisition (Executive Priority)',
        details: `Requisition ${row.public_id} auto-approved by Executive and sent to IT`,
        targetId: row.public_id,
      });

      await notifyUser({
        targetEmail: email,
        subject: `Requisition ${row.public_id} sent to IT`,
        title: 'Asset request sent to IT (Executive Priority)',
        text: `Your requisition ${row.public_id} for "${row.item}" was auto-approved as an Executive request and sent directly to IT Admin for action.`,
        type: 'success',
        ctaLabel: 'View pending approvals',
        ctaUrl: `${portal}/approvals`,
        name,
        details: requisitionDetails(row, { executivePriority: true }),
        event: 'requisition.created_executive',
        vars: requisitionVars(row, {
          executivePriority: true,
          actionedBy: req.authz?.user?.name,
        }),
      });

      await workflow.notifyRoleFlag(
        'is_it_admin',
        `Executive Priority — Requisition ${row.public_id}`,
        `Executive ${req.authz.user.name} submitted requisition ${row.public_id} for "${row.item}". Line Manager approval was skipped — please action under Pending Approvals.`,
        'warning',
        {
          details: requisitionDetails(row, {
            executivePriority: true,
            actionedBy: req.authz.user.name,
          }),
          event: 'requisition.created_executive',
          vars: requisitionVars(row, {
            executivePriority: true,
            actionedBy: req.authz?.user?.name,
          }),
        }
      );

      await notifyModuleUsers(
        'procurement_log',
        `Executive Priority Requisition ${row.public_id}`,
        `Executive ${req.authz.user.name} auto-approved requisition ${row.public_id} (${row.item}). Ready for IT Admin action.`,
        'warning',
        {
          title: 'Executive Priority request ready for IT',
          ctaLabel: 'Open pending approvals',
          ctaUrl: `${portal}/approvals`,
          details: requisitionDetails(row, { executivePriority: true }),
          event: 'requisition.created_executive',
          vars: requisitionVars(row, {
            executivePriority: true,
            actionedBy: req.authz?.user?.name,
          }),
          excludeEmails: [req.authz.user.email, row.requester_email],
        }
      );
    } else {
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
    }

    return res.status(201).json({ success: true, data: await withReplies(row) });
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

    return res.json({ success: true, data: await withReplies(result.rows[0]) });
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

async function approve(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }

    const gate = workflow.canActOnStage(req, row);
    if (!gate.ok) {
      return res.status(403).json({ success: false, message: gate.message });
    }
    if (gate.stage === 'it_pricing') {
      return res.status(400).json({
        success: false,
        message: 'Use submit-pricing to submit vendor pricing at this stage.',
      });
    }

    const actorUser = actor(req);
    let updated;

    switch (gate.stage) {
      case 'line_manager':
        updated = await workflow.afterLineManagerApprove(row, actorUser);
        break;
      case 'finance':
        updated = await workflow.afterFinanceApprove(row, actorUser);
        break;
      case 'hr':
        updated = await workflow.afterHrApprove(row, actorUser);
        break;
      case 'gm':
        updated = await workflow.afterGmApprove(row, actorUser);
        break;
      case 'executive':
      case 'executive_override':
        updated = await workflow.afterExecutiveApprove(row, actorUser);
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
      details: `Approved ${row.public_id} at stage ${gate.stage}; status → ${updated.status}`,
      targetId: row.public_id,
    });

    return res.json({ success: true, data: await withReplies(updated) });
  } catch (err) {
    return next(err);
  }
}

async function reject(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }

    // IT Admin / final IT queue stages cannot reject via this endpoint
    if (
      IT_QUEUE_STATUSES.includes(row.status) ||
      row.status === REQ_STATUS.COMPLETED ||
      row.status === REQ_STATUS.PENDING_IT_PRICING
    ) {
      return res.status(403).json({
        success: false,
        message: 'Rejection is not allowed at this stage (IT fulfillment / pricing).',
      });
    }

    const gate = workflow.canActOnStage(req, row);
    if (!gate.ok) {
      return res.status(403).json({ success: false, message: gate.message });
    }
    if (!gate.canReject) {
      return res.status(403).json({
        success: false,
        message: 'You cannot reject this request at the current stage.',
      });
    }

    const reason = req.body.reason || 'Rejected';
    const today = new Date().toISOString().split('T')[0];
    const history = `${row.decision_history || ''}Rejected by ${req.authz.user.name} on ${today}: ${reason}\n`;

    const updated = await workflow.setStatus(row.id, REQ_STATUS.REJECTED, {
      decision_history: history,
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
      details: `Rejected ${row.public_id}: ${reason}`,
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

    return res.json({ success: true, data: await withReplies(updated) });
  } catch (err) {
    return next(err);
  }
}

/**
 * IT Admin submits vendor pricing when inventory is unavailable.
 * Body: { total_price, vendor_quotes }
 */
async function submitPricing(req, res, next) {
  try {
    const row = await findReq(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Requisition not found' });
    }
    if (!isItAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only IT Admin can submit pricing.',
      });
    }
    if (row.status !== REQ_STATUS.PENDING_IT_PRICING) {
      return res.status(400).json({
        success: false,
        message: `Pricing can only be submitted when status is "${REQ_STATUS.PENDING_IT_PRICING}".`,
      });
    }

    const { total_price, vendor_quotes } = req.body || {};
    if (total_price === undefined || total_price === null || Number.isNaN(Number(total_price))) {
      return res.status(400).json({ success: false, message: 'total_price is required' });
    }
    if (vendor_quotes === undefined || vendor_quotes === null) {
      return res.status(400).json({ success: false, message: 'vendor_quotes is required' });
    }

    const today = new Date().toISOString().split('T')[0];
    const price = Number(total_price);
    const updated = await workflow.setStatus(row.id, REQ_STATUS.PENDING_FINANCE, {
      total_price: price,
      vendor_quotes,
      decision_history:
        `${row.decision_history || ''}IT pricing submitted by ${req.authz.user.name} on ${today}. Total: ${price}. Routed to Finance.\n`,
    });

    await workflow.addReply(
      row.id,
      req.authz.user.name,
      roleLabel(req),
      `Submitted vendor pricing. Total price: ${price}. Awaiting Finance approval.`
    );

    await addAuditLog({
      user: actor(req),
      action: 'Submitted Requisition Pricing',
      details: `Submitted pricing for ${row.public_id}: ${price}`,
      targetId: row.public_id,
    });

    const details = requisitionDetails(updated, { actionedBy: req.authz.user.name });
    await workflow.notifyRoleFlag(
      'is_finance_manager',
      `Finance approval needed — ${row.public_id}`,
      `Request ${row.public_id} for "${row.item}" has vendor pricing (total ${price}) and awaits Finance approval.`,
      'warning',
      {
        details,
        event: 'requisition.pending_finance',
        vars: requisitionVars(updated),
      }
    );

    await workflow.notifyRequester(
      updated,
      `Request ${row.public_id} — pending Finance`,
      `IT submitted vendor pricing for ${row.public_id}. Awaiting Finance approval.`,
      'info',
      { details, event: 'requisition.pricing_submitted', vars: requisitionVars(updated) }
    );

    return res.json({ success: true, data: await withReplies(updated) });
  } catch (err) {
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

    return res.json({ success: true, data: await withReplies(result.rows[0]) });
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

  return res.json({ success: true, data: await withReplies(result.rows[0]) });
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

    const linked = row.linked_asset_ids;
    let linkedList = [];
    if (Array.isArray(linked)) linkedList = linked;
    else if (typeof linked === 'string') {
      try {
        linkedList = JSON.parse(linked) || [];
      } catch {
        linkedList = [];
      }
    }

    const assetLink = await db.query(
      `SELECT id FROM user_assets
       WHERE source_req_id = $1 OR source_req_public_id = $2
       LIMIT 1`,
      [row.id, row.public_id]
    );

    if (!linkedList.length && !assetLink.rows.length) {
      return res.status(400).json({
        success: false,
        message:
          'Cannot complete: assign at least one asset linked to this request (Assign Assets → link request).',
      });
    }

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

    return res.json({ success: true, data: await withReplies(row) });
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
  submitPricing,
  hold,
  inProgress,
  resume,
  complete,
  reply,
};
