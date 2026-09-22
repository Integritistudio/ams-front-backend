const db = require('../config/database');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser, notifyMany } = require('../services/notifyService');

const REQ_SLA = { Urgent: 48, Standard: 120 };

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function roleLabel(req) {
  return req.authz?.role?.name || 'User';
}

/** Only the designated Approver assignee may approve/reject — never IT Admin. */
function assertAssignedApprover(req, row, action = 'approve') {
  const role = req.authz?.role;
  if (role?.is_it_admin || role?.is_executive) {
    const err = new Error(
      role?.is_it_admin
        ? `IT Admin cannot ${action} asset requests. Only the designated Approver can ${action}.`
        : `Executive users cannot ${action} asset requests. Only the designated Approver can ${action}.`
    );
    err.status = 403;
    throw err;
  }
  if (!role?.is_approver) {
    const err = new Error(`Only the designated Approver role can ${action} this request.`);
    err.status = 403;
    throw err;
  }
  if (Number(row.approver_id) !== Number(req.authz.user.id)) {
    const err = new Error(`Only the assigned Approver can ${action} this request.`);
    err.status = 403;
    throw err;
  }
}

function slaHours(urgency) {
  return REQ_SLA[urgency] || REQ_SLA.Standard;
}

async function findReq(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM requisitions WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM requisitions WHERE public_id = $1`, [key]);
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

function isItAdmin(req) {
  return Boolean(req.authz?.role?.is_it_admin);
}

function isApproverRole(req) {
  return Boolean(req.authz?.role?.is_approver);
}

function isExecutive(req) {
  return Boolean(req.authz?.role?.is_executive);
}

/** IT Admin, Approver, or Executive — see full pending Approval Asset queue */
function canSeeAllPendingApprovals(req) {
  return isItAdmin(req) || isApproverRole(req) || isExecutive(req);
}

function canAccessReq(req, row) {
  if (canSeeAllPendingApprovals(req) || canViewAll('requisitions')(req) || canViewAll('approvals')(req)) {
    return true;
  }
  const email = (req.authz.user.email || '').toLowerCase();
  if ((row.requester_email || '').toLowerCase() === email) return true;
  if (row.approver_id && Number(row.approver_id) === Number(req.authz.user.id)) return true;
  return false;
}

async function notifyModuleUsers(moduleSlug, subject, text, type = 'info', extra = {}) {
  const result = await db.query(
    `SELECT DISTINCT u.email
     FROM users u
     JOIN role_permissions rp ON rp.role_id = u.role_id
     JOIN modules m ON m.id = rp.module_id
     WHERE m.slug = $1 AND u.status = 'Active' AND m.is_active = TRUE`,
    [moduleSlug]
  );
  await notifyMany(
    result.rows.map((r) => r.email),
    {
      subject,
      title: extra.title || subject,
      text,
      type,
      ctaLabel: extra.ctaLabel,
      ctaUrl: extra.ctaUrl,
    }
  );
}

async function list(req, res, next) {
  try {
    let result;
    if (
      canSeeAllPendingApprovals(req) ||
      canViewAll('requisitions')(req) ||
      canViewAll('approvals')(req)
    ) {
      result = await db.query(`SELECT * FROM requisitions ORDER BY created_timestamp DESC`);
    } else {
      // Regular users: only their own requests (any status)
      result = await db.query(
        `SELECT * FROM requisitions
         WHERE LOWER(requester_email) = LOWER($1)
            OR approver_id = $2
         ORDER BY created_timestamp DESC`,
        [req.authz.user.email, req.authz.user.id]
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
    if (!canAccessReq(req, row)) {
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
      approver_id,
      approver_name,
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
    if (!approver_id) {
      return res.status(400).json({ success: false, message: 'approver_id is required' });
    }
    if (!String(project || '').trim()) {
      return res.status(400).json({ success: false, message: 'project reference is required' });
    }

    const approver = await db.query(
      `SELECT u.id, u.name, u.email, COALESCE(r.is_approver, FALSE) AS is_approver
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1 AND u.status = 'Active'`,
      [approver_id]
    );
    if (!approver.rows[0]) {
      return res.status(400).json({ success: false, message: 'Invalid approver_id' });
    }
    if (!approver.rows[0].is_approver) {
      return res.status(400).json({
        success: false,
        message: 'Selected user is not the designated Approver. Configure Approver in Role Management.',
      });
    }

    const defaultName = req.authz.user.name;
    const defaultEmail = (req.authz.user.email || '').toLowerCase();
    const mayBehalf = canViewAll('requisitions')(req);
    const name = mayBehalf && requester_name ? requester_name : defaultName;
    const email = (mayBehalf && requester_email ? requester_email : defaultEmail).toLowerCase();
    const isBehalf =
      Boolean(on_behalf) &&
      mayBehalf &&
      email !== defaultEmail;

    let requesterId = req.authz.user.id;
    if (isBehalf) {
      const uRes = await db.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      );
      if (uRes.rows[0]) requesterId = uRes.rows[0].id;
    }

    const urg = urgency || 'Standard';
    const pid = publicId('REQ');

    const result = await db.query(
      `INSERT INTO requisitions (
         public_id, requester_id, requester_name, requester_email, department,
         approver_id, approver_name, type, item, project, urgency, justification,
         status, attachment_url
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Pending Manager Approval',$13)
       RETURNING *`,
      [
        pid,
        requesterId,
        name,
        email,
        department || req.authz.user.department || null,
        approver.rows[0].id,
        approver_name || approver.rows[0].name,
        type,
        item,
        String(project).trim(),
        urg,
        justification || null,
        attachment_url || null,
      ]
    );

    const row = result.rows[0];
    await addAuditLog({
      user: actor(req),
      action: 'Submitted Requisition',
      details: isBehalf
        ? `Requisition ${row.public_id} submitted on behalf of ${name} to ${row.approver_name}`
        : `Requisition ${row.public_id} forwarded to ${row.approver_name}`,
      targetId: row.public_id,
    });

    const portal = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');

    await notifyUser({
      targetEmail: approver.rows[0].email,
      subject: `Pending Requisition ${row.public_id}`,
      title: 'Asset requisition needs your approval',
      text: `New asset requisition ${row.public_id} for "${row.item}" was submitted by ${name} and needs your approval.`,
      type: 'warning',
      ctaLabel: 'Review approval',
      ctaUrl: `${portal}/approvals`,
    });

    await notifyUser({
      targetEmail: email,
      subject: `Requisition ${row.public_id} submitted`,
      title: 'Asset requisition submitted',
      text: `Your requisition ${row.public_id} for "${row.item}" was forwarded to ${row.approver_name}.`,
      type: 'info',
      ctaLabel: 'View requisition',
      ctaUrl: `${portal}/requisitions`,
    });

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
    if (!canAccessReq(req, row)) {
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
    try {
      assertAssignedApprover(req, row, 'approve');
    } catch (denied) {
      if (denied.status) {
        return res.status(denied.status).json({ success: false, message: denied.message });
      }
      throw denied;
    }
    if (row.status !== 'Pending Manager Approval') {
      return res.status(400).json({ success: false, message: 'Requisition is not pending approval' });
    }

    const hours = slaHours(row.urgency);
    const due = new Date(Date.now() + hours * 60 * 60 * 1000);
    const today = new Date().toISOString().split('T')[0];
    const history = `${row.decision_history || ''}Approved by ${req.authz.user.name} on ${today}. ${hours}h SLA.\n`;

    const result = await db.query(
      `UPDATE requisitions SET
         status = 'Approved - Sent to IT',
         due_timestamp = $2,
         decision_history = $3,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [row.id, due, history]
    );

    await db.query(
      `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [
        row.id,
        req.authz.user.name,
        roleLabel(req),
        `Approved and forwarded to IT with ${hours}h SLA.`,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Approved Requisition',
      details: `Approved ${row.public_id}; ${hours}h SLA`,
      targetId: row.public_id,
    });

    const portal = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');

    await notifyUser({
      targetEmail: row.requester_email,
      subject: `Approved Requisition ${row.public_id}`,
      title: 'Requisition approved',
      text: `Your requisition ${row.public_id} has been approved by ${req.authz.user.name} and forwarded to IT for fulfillment.`,
      type: 'success',
      ctaLabel: 'View requisition',
      ctaUrl: `${portal}/requisitions`,
    });

    await notifyModuleUsers(
      'procurement_log',
      `Approved Requisition ${row.public_id}`,
      `Manager approved requisition ${row.public_id} (${row.item}). Ready for IT delivery.`,
      'success',
      {
        title: 'Approved requisition ready for procurement',
        ctaLabel: 'Open procurement',
        ctaUrl: `${portal}/procurement`,
      }
    );

    return res.json({ success: true, data: await withReplies(result.rows[0]) });
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
    try {
      assertAssignedApprover(req, row, 'reject');
    } catch (denied) {
      if (denied.status) {
        return res.status(denied.status).json({ success: false, message: denied.message });
      }
      throw denied;
    }

    const reason = req.body.reason || 'Rejected';
    const today = new Date().toISOString().split('T')[0];
    const history = `${row.decision_history || ''}Rejected by ${req.authz.user.name} on ${today}: ${reason}\n`;

    const result = await db.query(
      `UPDATE requisitions SET
         status = 'Rejected',
         decision_history = $2,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [row.id, history]
    );

    await db.query(
      `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [row.id, req.authz.user.name, roleLabel(req), `Rejected: ${reason}`]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Rejected Requisition',
      details: `Rejected ${row.public_id}: ${reason}`,
      targetId: row.public_id,
    });

    await notifyUser({
      targetEmail: row.requester_email,
      subject: `Rejected Requisition ${row.public_id}`,
      title: 'Requisition rejected',
      text: `Your requisition ${row.public_id} was rejected by ${req.authz.user.name}: ${reason}`,
      type: 'error',
      ctaLabel: 'View requisition',
      ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/requisitions`,
    });

    return res.json({ success: true, data: await withReplies(result.rows[0]) });
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
    if (!canViewAll('requisitions')(req) && !canViewAll('procurement_log')(req)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { status } = req.body;
    const reason = req.body.reason || req.body.hold_reason || req.body.holdReason;
    const nextStatus = status || (row.status === 'On Hold' ? 'In Procurement' : 'On Hold');
    const holdReason = nextStatus === 'On Hold' ? reason || row.hold_reason : null;

    if (nextStatus === 'On Hold' && !holdReason) {
      return res.status(400).json({ success: false, message: 'reason is required when placing on hold' });
    }

    const result = await db.query(
      `UPDATE requisitions SET
         status = $2,
         hold_reason = $3,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [row.id, nextStatus, holdReason]
    );

    const replyText =
      nextStatus === 'On Hold'
        ? `[PROCUREMENT ON HOLD] Reason: ${holdReason}`
        : 'Procurement resumed from hold.';

    await db.query(
      `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [row.id, req.authz.user.name, roleLabel(req), replyText]
    );

    await addAuditLog({
      user: actor(req),
      action: nextStatus === 'On Hold' ? 'Requisition On Hold' : 'Resumed Requisition',
      details: replyText,
      targetId: row.public_id,
    });

    await notifyUser({
      targetEmail: row.requester_email,
      subject: `Requisition ${row.public_id}: ${nextStatus}`,
      title: `Requisition ${nextStatus}`,
      text: replyText,
      type: nextStatus === 'On Hold' ? 'warning' : 'info',
      ctaLabel: 'View requisition',
      ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/requisitions`,
    });

    return res.json({ success: true, data: await withReplies(result.rows[0]) });
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
    if (!canAccessReq(req, row)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    await db.query(
      `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [row.id, req.authz.user.name, roleLabel(req), text.trim()]
    );

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
        ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/requisitions`,
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
  hold,
  reply,
};
