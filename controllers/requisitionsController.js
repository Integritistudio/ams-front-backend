const db = require('../config/database');
const Role = require('../models/Role');
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

/** Assigned signer may approve/reject — Approver or Executive (never IT Admin). */
async function assertAssignedApprover(req, row, action = 'approve') {
  const role = req.authz?.role;
  if (role?.is_it_admin) {
    const err = new Error(
      `IT Admin cannot ${action} asset requests. Only the assigned Approver or Executive can ${action}.`
    );
    err.status = 403;
    throw err;
  }
  if (!role?.is_approver && !role?.is_executive) {
    const err = new Error(`Only Approver or Executive roles can ${action} this request.`);
    err.status = 403;
    throw err;
  }
  if (Number(row.approver_id) !== Number(req.authz.user.id)) {
    const err = new Error(`Only the assigned signer can ${action} this request.`);
    err.status = 403;
    throw err;
  }

  // Approver-created (or self-requested by Approver) → Executive only; no self-approve
  const createdByApprover = await requesterIsApprover(row);
  const isSelfRequest =
    Number(row.requester_id) === Number(req.authz.user.id) ||
    (row.requester_email || '').toLowerCase() === (req.authz.user.email || '').toLowerCase();

  if (createdByApprover || (role.is_approver && isSelfRequest)) {
    if (!role.is_executive) {
      const err = new Error(
        `Approver-created requests must be ${action}d by an Executive. You cannot ${action} your own request.`
      );
      err.status = 403;
      throw err;
    }
  }
}

function slaHours(urgency) {
  return REQ_SLA[urgency] || REQ_SLA.Standard;
}

async function findReq(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(
        `${LIST_SELECT}
         WHERE req.id = $1`,
        [key]
      )
    : await db.query(
        `${LIST_SELECT}
         WHERE req.public_id = $1`,
        [key]
      );
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

/** Full pending queue: IT Admin + Approver only (Executive has a scoped queue). */
function canSeeAllPendingApprovals(req) {
  return isItAdmin(req) || isApproverRole(req);
}

async function requesterIsApprover(row) {
  if (!row) return false;
  if (row.requester_id) {
    const r = await db.query(
      `SELECT COALESCE(r.is_approver, FALSE) AS is_approver
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [row.requester_id]
    );
    return Boolean(r.rows[0]?.is_approver);
  }
  if (row.requester_email) {
    const r = await db.query(
      `SELECT COALESCE(r.is_approver, FALSE) AS is_approver
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE LOWER(u.email) = LOWER($1) LIMIT 1`,
      [row.requester_email]
    );
    return Boolean(r.rows[0]?.is_approver);
  }
  return false;
}

async function canAccessReq(req, row) {
  // Approver + IT Admin: full queue
  if (isItAdmin(req) || isApproverRole(req)) return true;

  // Executive: view-all asset requests (Pending Approvals still filtered on the client)
  if (isExecutive(req)) return true;

  const email = (req.authz.user.email || '').toLowerCase();
  if ((row.requester_email || '').toLowerCase() === email) return true;
  if (row.approver_id && Number(row.approver_id) === Number(req.authz.user.id)) return true;

  if (canViewAll('requisitions')(req) || canViewAll('approvals')(req)) return true;
  return false;
}

const LIST_SELECT = `
  SELECT req.*,
         COALESCE(rr.is_approver, FALSE) AS requester_is_approver,
         COALESCE(rr.is_executive, FALSE) AS requester_is_executive
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
    if (isItAdmin(req) || isApproverRole(req) || isExecutive(req)) {
      // IT Admin / Approver / Executive: full asset request list (viewer for Executive)
      // Pending Approvals for Executive is filtered client-side to Approver-created only
      result = await db.query(`${LIST_SELECT} ORDER BY req.created_timestamp DESC`);
    } else if (canViewAll('requisitions')(req) || canViewAll('approvals')(req)) {
      result = await db.query(`${LIST_SELECT} ORDER BY req.created_timestamp DESC`);
    } else {
      result = await db.query(
        `${LIST_SELECT}
         WHERE LOWER(req.requester_email) = LOWER($1)
            OR req.approver_id = $2
         ORDER BY req.created_timestamp DESC`,
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
    if (!String(project || '').trim()) {
      return res.status(400).json({ success: false, message: 'project reference is required' });
    }

    // Executive (not Approver): skip manager approval → auto-send to IT with priority flag
    const executiveDirectToIt = isExecutive(req) && !isApproverRole(req);
    // Hierarchy: staff → Approver; Approver-created → Executive (never self)
    const needsExecutiveSigner = isApproverRole(req);

    if (!executiveDirectToIt && !approver_id) {
      return res.status(400).json({ success: false, message: 'approver_id is required' });
    }

    let signerId = approver_id;
    let signerRow = null;

    if (executiveDirectToIt) {
      // Auto-approve: Executive is recorded as the auto-signer; no manager pending
      signerRow = {
        id: req.authz.user.id,
        name: req.authz.user.name,
        email: req.authz.user.email,
        is_approver: false,
        is_executive: true,
      };
    } else if (needsExecutiveSigner) {
      // Force an Executive; ignore client picking the Approver themselves
      const executives = await Role.findUsersWithFlag('is_executive');
      if (!executives.length) {
        return res.status(400).json({
          success: false,
          message: 'No Executive configured. Assign Executive role in Role Management before Approver can submit requests.',
        });
      }
      const picked =
        executives.find((e) => Number(e.id) === Number(approver_id)) || executives[0];
      if (Number(picked.id) === Number(req.authz.user.id)) {
        const other = executives.find((e) => Number(e.id) !== Number(req.authz.user.id));
        if (!other) {
          return res.status(400).json({
            success: false,
            message: 'Approver cannot approve their own request. Configure a different Executive user.',
          });
        }
        signerId = other.id;
      } else {
        signerId = picked.id;
      }
    }

    if (!executiveDirectToIt) {
      const approver = await db.query(
        `SELECT u.id, u.name, u.email,
                COALESCE(r.is_approver, FALSE) AS is_approver,
                COALESCE(r.is_executive, FALSE) AS is_executive
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.status = 'Active'`,
        [signerId]
      );
      if (!approver.rows[0]) {
        return res.status(400).json({ success: false, message: 'Invalid approver_id' });
      }
      if (needsExecutiveSigner) {
        if (!approver.rows[0].is_executive) {
          return res.status(400).json({
            success: false,
            message:
              'Approver-created requests must be sent to an Executive. Select a user with Executive role permission.',
          });
        }
        if (Number(approver.rows[0].id) === Number(req.authz.user.id)) {
          return res.status(400).json({
            success: false,
            message: 'You cannot assign yourself as signer on your own request. An Executive must approve it.',
          });
        }
      } else if (!approver.rows[0].is_approver) {
        return res.status(400).json({
          success: false,
          message: 'Selected user is not the designated Approver. Configure Approver in Role Management.',
        });
      }
      signerRow = approver.rows[0];
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
    const today = new Date().toISOString().split('T')[0];
    const hours = slaHours(urg);

    let initialStatus = 'Pending Manager Approval';
    let dueTimestamp = null;
    let decisionHistory = null;
    let storedApproverName = approver_name || signerRow.name;

    if (executiveDirectToIt) {
      initialStatus = 'Approved - Sent to IT';
      dueTimestamp = new Date(Date.now() + hours * 60 * 60 * 1000);
      decisionHistory =
        `[EXECUTIVE_PRIORITY] Auto-approved by Executive ${req.authz.user.name} on ${today}. ` +
        `Manager approval skipped — sent directly to IT Admin with ${hours}h SLA.\n`;
      storedApproverName = `${req.authz.user.name} (Executive Auto-Approved)`;
    }

    const result = await db.query(
      `INSERT INTO requisitions (
         public_id, requester_id, requester_name, requester_email, department,
         approver_id, approver_name, type, item, project, urgency, justification,
         status, attachment_url, due_timestamp, decision_history
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        pid,
        requesterId,
        name,
        email,
        department || req.authz.user.department || null,
        signerRow.id,
        storedApproverName,
        type,
        item,
        String(project).trim(),
        urg,
        justification || null,
        initialStatus,
        attachment_url || null,
        dueTimestamp,
        decisionHistory,
      ]
    );

    const row = result.rows[0];

    if (executiveDirectToIt) {
      await db.query(
        `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
         VALUES ($1, $2, $3, $4)`,
        [
          row.id,
          'System',
          'System',
          `[EXECUTIVE PRIORITY] Auto-approved by Executive ${req.authz.user.name}. Sent directly to IT Admin (${hours}h SLA).`,
        ]
      );
    }

    await addAuditLog({
      user: actor(req),
      action: executiveDirectToIt ? 'Submitted Requisition (Executive Priority)' : 'Submitted Requisition',
      details: executiveDirectToIt
        ? `Requisition ${row.public_id} auto-approved by Executive and sent to IT`
        : isBehalf
          ? `Requisition ${row.public_id} submitted on behalf of ${name} to ${row.approver_name}`
          : `Requisition ${row.public_id} forwarded to ${row.approver_name}`,
      targetId: row.public_id,
    });

    const portal = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');

    if (executiveDirectToIt) {
      await notifyUser({
        targetEmail: email,
        subject: `Requisition ${row.public_id} sent to IT`,
        title: 'Asset request sent to IT (Executive Priority)',
        text: `Your requisition ${row.public_id} for "${row.item}" was auto-approved as an Executive request and sent directly to IT Admin for action.`,
        type: 'success',
        ctaLabel: 'View pending approvals',
        ctaUrl: `${portal}/approvals`,
        name,
      });

      const itAdmin = await Role.findDesignatedUser('is_it_admin');
      if (itAdmin?.email) {
        await notifyUser({
          targetEmail: itAdmin.email,
          subject: `Executive Priority — Requisition ${row.public_id}`,
          title: 'Executive Priority asset request awaiting IT action',
          text: `Executive ${req.authz.user.name} submitted requisition ${row.public_id} for "${row.item}". Manager approval was skipped — please action under Pending Approvals.`,
          type: 'warning',
          ctaLabel: 'Open pending approvals',
          ctaUrl: `${portal}/approvals`,
          name: itAdmin.name,
        });
      }

      await notifyModuleUsers(
        'procurement_log',
        `Executive Priority Requisition ${row.public_id}`,
        `Executive auto-approved requisition ${row.public_id} (${row.item}). Ready for IT Admin action.`,
        'warning',
        {
          title: 'Executive Priority request ready for IT',
          ctaLabel: 'Open pending approvals',
          ctaUrl: `${portal}/approvals`,
        }
      );
    } else {
      await notifyUser({
        targetEmail: signerRow.email,
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
      await assertAssignedApprover(req, row, 'approve');
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
      `Manager approved requisition ${row.public_id} (${row.item}). Ready for IT Admin action under Pending Approvals.`,
      'success',
      {
        title: 'Approved requisition ready for IT',
        ctaLabel: 'Open pending approvals',
        ctaUrl: `${portal}/approvals`,
      }
    );

    // Also notify the designated IT Admin user directly
    const itAdmin = await Role.findDesignatedUser('is_it_admin');
    if (itAdmin?.email) {
      await notifyUser({
        targetEmail: itAdmin.email,
        subject: `Approved Requisition ${row.public_id} — action required`,
        title: 'Asset request awaiting IT Admin action',
        text: `Requisition ${row.public_id} for "${row.item}" was approved and sent to IT. Please review it under Pending Approvals.`,
        type: 'warning',
        ctaLabel: 'Open pending approvals',
        ctaUrl: `${portal}/approvals`,
      });
    }

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
      await assertAssignedApprover(req, row, 'reject');
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
    if (!isItAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only IT Admin can put asset requests on hold or resume them',
      });
    }

    const { status } = req.body;
    const reason = req.body.reason || req.body.hold_reason || req.body.holdReason;
    // Resume from hold → In Progress (ticket-like workflow)
    const nextStatus = status || (row.status === 'On Hold' ? 'In Progress' : 'On Hold');
    const holdReason = nextStatus === 'On Hold' ? reason || row.hold_reason : null;

    if (nextStatus === 'On Hold' && !holdReason) {
      return res.status(400).json({ success: false, message: 'reason is required when placing on hold' });
    }

    const itActionStatuses = [
      'Approved - Sent to IT',
      'In Progress',
      'In Procurement',
      'On Hold',
    ];
    if (nextStatus === 'On Hold' && !itActionStatuses.includes(row.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot hold a request with status "${row.status}"`,
      });
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
        ? `[ASSET REQUEST ON HOLD] Reason: ${holdReason}`
        : 'IT Admin resumed work on asset request from hold status.';

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

async function assertItAdminAction(req, row, actionLabel) {
  if (!isItAdmin(req)) {
    const err = new Error(`Only IT Admin can ${actionLabel} asset requests`);
    err.status = 403;
    throw err;
  }
  const allowed = ['Approved - Sent to IT', 'In Progress', 'In Procurement', 'On Hold'];
  if (!allowed.includes(row.status)) {
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
       hold_reason = $3,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [row.id, status, holdReason === undefined ? row.hold_reason : holdReason]
  );

  if (replyText) {
    await db.query(
      `INSERT INTO requisition_replies (requisition_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [row.id, req.authz.user.name, roleLabel(req), replyText]
    );
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
    type: status === 'Completed' ? 'success' : status === 'On Hold' ? 'warning' : 'info',
    ctaLabel: 'View requisition',
    ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/requisitions`,
  });

  // When IT Admin marks Completed, also notify the Approver / assigned signer
  if (status === 'Completed' && row.approver_id) {
    const approverRes = await db.query(
      `SELECT email, name FROM users WHERE id = $1 AND status = 'Active' LIMIT 1`,
      [row.approver_id]
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
        ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/requisitions`,
        name: approver.name,
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
      'In Progress',
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
      'In Progress',
      'IT Admin resumed work on asset request from hold status.',
      null
    );
  } catch (err) {
    return next(err);
  }
}

async function complete(req, res, next) {
  try {
    const body = req.body || {};
    const note = body.note || body.resolution || 'Asset request marked completed';
    return await setReqStatus(
      req,
      res,
      next,
      'Completed',
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
  inProgress,
  resume,
  complete,
  reply,
};
