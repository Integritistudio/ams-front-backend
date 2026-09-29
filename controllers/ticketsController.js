const db = require('../config/database');
const Role = require('../models/Role');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');
const { ticketDetails, ticketVars } = require('../services/emailDetails');
const { TICKET_STATUS } = require('../services/workflowConstants');

const TICKET_SLA = { High: 4, Medium: 24, Low: 48 };
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function roleLabel(req) {
  return req.authz?.role?.name || 'User';
}

function portalBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function slaHours(priority) {
  return TICKET_SLA[priority] || TICKET_SLA.Medium;
}

async function findTicket(idOrPublic) {
  const key = String(idOrPublic);
  const byId = /^\d+$/.test(key)
    ? await db.query('SELECT * FROM tickets WHERE id = $1', [key])
    : await db.query('SELECT * FROM tickets WHERE public_id = $1', [key]);
  return byId.rows[0] || null;
}

async function loadReplies(ticketId) {
  const result = await db.query(
    'SELECT * FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticketId]
  );
  return result.rows;
}

async function withReplies(ticket) {
  if (!ticket) return null;
  return { ...ticket, replies: await loadReplies(ticket.id) };
}

function isItAdmin(req) {
  return Boolean(req.authz?.role?.is_it_admin);
}

function isExecutive(req) {
  return Boolean(req.authz?.role?.is_executive);
}

function isPendingLineManager(ticket) {
  const s = (ticket?.status || '').trim();
  return (
    s === TICKET_STATUS.PENDING_LINE_MANAGER ||
    s.toLowerCase() === 'pending line manager'
  );
}

function canViewAllTickets(req) {
  return (
    canViewAll('tickets')(req) ||
    isItAdmin(req) ||
    isExecutive(req) ||
    Boolean(req.authz?.role?.is_hr_manager) ||
    Boolean(req.authz?.role?.is_gm)
  );
}

function isTicketLineManager(req, ticket) {
  const userId = Number(req.authz?.user?.id);
  if (!userId || !ticket) return false;
  return Boolean(ticket.line_manager_id && Number(ticket.line_manager_id) === userId);
}

async function isManagerOfRequester(req, ticket) {
  const userId = Number(req.authz?.user?.id);
  if (!userId || !ticket?.requester_id) return false;
  const result = await db.query(
    'SELECT manager_id FROM users WHERE id = $1 LIMIT 1',
    [ticket.requester_id]
  );
  const managerId = result.rows[0]?.manager_id;
  return managerId != null && Number(managerId) === userId;
}

function canAccessTicket(req, ticket) {
  if (canViewAllTickets(req)) return true;
  if (isTicketLineManager(req, ticket)) return true;
  return (
    (ticket.requester_email || '').toLowerCase() ===
    (req.authz.user.email || '').toLowerCase()
  );
}

async function resolveAssigneeEmail(assignedTo) {
  if (!assignedTo) return null;
  if (String(assignedTo).includes('@')) return String(assignedTo).toLowerCase();
  if (assignedTo === 'IT Support') return null;
  const assignee = await db.query(
    "SELECT email FROM users WHERE LOWER(name) = LOWER($1) AND status = 'Active' LIMIT 1",
    [assignedTo]
  );
  return assignee.rows[0]?.email ? String(assignee.rows[0].email).toLowerCase() : null;
}

async function list(req, res, next) {
  try {
    let result;
    if (canViewAllTickets(req)) {
      result = await db.query('SELECT * FROM tickets ORDER BY created_timestamp DESC');
    } else {
      result = await db.query(
        `SELECT * FROM tickets
         WHERE LOWER(requester_email) = LOWER($1) OR line_manager_id = $2
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
    const ticket = await findTicket(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!canAccessTicket(req, ticket)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    return res.json({ success: true, data: await withReplies(ticket) });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const {
      requester_name, requester_email, subject, category, other_category,
      department, priority, description, attachment_url, on_behalf,
    } = req.body;

    if (!subject) {
      return res.status(400).json({ success: false, message: 'subject is required' });
    }

    const defaultName = req.authz.user.name;
    const defaultEmail = (req.authz.user.email || '').toLowerCase();
    const mayBehalf = isItAdmin(req);
    const name = mayBehalf && requester_name ? requester_name : defaultName;
    const email = (mayBehalf && requester_email ? requester_email : defaultEmail).toLowerCase();
    const isBehalf = Boolean(on_behalf) && mayBehalf && email !== defaultEmail;

    let prio = null;
    if (priority != null && String(priority).trim() !== '') {
      const normalized = String(priority).trim();
      if (!VALID_PRIORITIES.includes(normalized)) {
        return res.status(400).json({
          success: false,
          message: 'priority must be High, Medium, or Low when provided',
        });
      }
      prio = normalized;
    }

    const pid = publicId('TKT');
    let requesterId = req.authz.user.id;
    if (isBehalf) {
      const uRes = await db.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email]
      );
      if (uRes.rows[0]) requesterId = uRes.rows[0].id;
    }

    const requesterRow = await db.query(
      'SELECT id, manager_id FROM users WHERE id = $1 LIMIT 1',
      [requesterId]
    );
    const lineManagerId = requesterRow.rows[0]?.manager_id || null;
    if (!lineManagerId && !isItAdmin(req)) {
      return res.status(400).json({
        success: false,
        message:
          'No Line Manager configured. Ask an administrator to set your manager before creating tickets.',
      });
    }

    const result = await db.query(
      `INSERT INTO tickets (
         public_id, requester_id, requester_name, requester_email, subject,
         category, other_category, department, priority, status, description,
         assigned_to, attachment_url, due_timestamp, line_manager_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        pid, requesterId, name, email, subject,
        category || null, other_category || null,
        department || req.authz.user.department || null,
        prio, TICKET_STATUS.PENDING_LINE_MANAGER, description || null,
        null, attachment_url || null, null, lineManagerId,
      ]
    );

    const ticket = result.rows[0];
    let lmName = 'your Line Manager';
    let lmEmail = null;
    if (lineManagerId) {
      const lmRes = await db.query(
        'SELECT id, name, email FROM users WHERE id = $1 LIMIT 1',
        [lineManagerId]
      );
      if (lmRes.rows[0]) {
        lmName = lmRes.rows[0].name || lmName;
        lmEmail = lmRes.rows[0].email || null;
      }
    }

    const behalfNote = isBehalf
      ? `Ticket opened by IT Admin (${req.authz.user.name}) on behalf of user ${name}. Awaiting Line Manager (${lmName}) review.`
      : `Ticket created. Awaiting Line Manager (${lmName}) to set priority and send to IT.`;

    await db.query(
      'INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, $2, $3, $4)',
      [ticket.id, 'System', 'System', behalfNote]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Created Ticket',
      details: isBehalf
        ? `Created ticket ${ticket.public_id} on behalf of ${name} (Pending Line Manager)`
        : `Created ticket ${ticket.public_id} (Pending Line Manager)`,
      targetId: ticket.public_id,
    });

    const portal = portalBase();
    await notifyUser({
      targetEmail: email,
      subject: `Ticket ${ticket.public_id} created`,
      title: 'Support ticket created',
      text: `Your ticket "${subject}" (${ticket.public_id}) was submitted and is pending Line Manager review.`,
      type: 'info',
      ctaLabel: 'View tickets',
      ctaUrl: `${portal}/tickets`,
      name,
      details: ticketDetails(ticket),
      event: 'ticket.created',
      vars: ticketVars(ticket, { recipientRole: 'Requester' }),
    });

    if (lmEmail && String(lmEmail).toLowerCase() !== email.toLowerCase()) {
      await notifyUser({
        targetEmail: lmEmail,
        subject: `Ticket ${ticket.public_id} needs your review`,
        title: 'Support ticket pending Line Manager review',
        text: `Ticket ${ticket.public_id} "${subject}" was submitted by ${name} and requires you to set priority or reject.`,
        type: 'warning',
        ctaLabel: 'Review ticket',
        ctaUrl: `${portal}/tickets`,
        name: lmName,
        details: ticketDetails(ticket),
        event: 'ticket.pending_line_manager',
        vars: ticketVars(ticket, { recipientRole: 'Line Manager' }),
      });
    }

    return res.status(201).json({ success: true, data: await withReplies(ticket) });
  } catch (err) {
    return next(err);
  }
}

async function lineManagerReview(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!isPendingLineManager(ticket)) {
      return res.status(400).json({
        success: false,
        message: 'Ticket is not pending Line Manager review',
      });
    }

    const isLm =
      isTicketLineManager(req, ticket) || (await isManagerOfRequester(req, ticket));
    if (!isLm) {
      return res.status(403).json({
        success: false,
        message: 'Only the assigned Line Manager can review this ticket',
      });
    }

    const body = req.body || {};
    const action = String(body.action || '').trim().toLowerCase();
    const portal = portalBase();

    if (action === 'send_to_it') {
      const priority = body.priority != null ? String(body.priority).trim() : '';
      if (!VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({
          success: false,
          message: 'priority is required (High, Medium, or Low) when sending to IT',
        });
      }

      const hours = slaHours(priority);
      const due = new Date(Date.now() + hours * 60 * 60 * 1000);
      const itAdmin = await Role.findDesignatedUser('is_it_admin');
      const assigneeLabel = itAdmin ? (itAdmin.email || itAdmin.name) : 'IT Support';

      const result = await db.query(
        `UPDATE tickets SET
           priority = $2, priority_set_by = $3, status = $4,
           assigned_to = $5, due_timestamp = $6, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [ticket.id, priority, req.authz.user.id, TICKET_STATUS.ASSIGNED, assigneeLabel, due]
      );
      const updated = result.rows[0];
      const replyText =
        `Line Manager ${req.authz.user.name} set priority to ${priority} and sent ticket to IT. ` +
        `Committed SLA: ${hours} hours. Assigned to ${assigneeLabel}.`;

      await db.query(
        'INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, $2, $3, $4)',
        [ticket.id, req.authz.user.name, roleLabel(req), replyText]
      );

      await addAuditLog({
        user: actor(req),
        action: 'Ticket Sent to IT',
        details: `Line Manager sent ${ticket.public_id} to IT with ${priority} priority (${hours}h SLA)`,
        targetId: ticket.public_id,
      });

      await notifyUser({
        targetEmail: ticket.requester_email,
        subject: `Ticket ${ticket.public_id} sent to IT`,
        title: 'Ticket prioritized and sent to IT',
        text: `Your ticket ${ticket.public_id} was reviewed by your Line Manager. Priority: ${priority}. Assigned to ${assigneeLabel}.`,
        type: 'info',
        ctaLabel: 'View ticket',
        ctaUrl: `${portal}/tickets`,
        name: ticket.requester_name,
        details: ticketDetails(updated),
        event: 'ticket.sent_to_it',
        vars: ticketVars(updated, { recipientRole: 'Requester', updatedBy: req.authz.user.name }),
      });

      const notified = new Set([(ticket.requester_email || '').toLowerCase()].filter(Boolean));
      if (itAdmin?.email) {
        const itEmail = String(itAdmin.email).toLowerCase();
        if (!notified.has(itEmail)) {
          await notifyUser({
            targetEmail: itAdmin.email,
            subject: `Ticket ${ticket.public_id} assigned`,
            title: 'New support ticket requires attention',
            text: `Ticket ${ticket.public_id} "${updated.subject}" was prioritized (${priority}) by Line Manager ${req.authz.user.name} and assigned to you.`,
            type: 'warning',
            ctaLabel: 'Open tickets',
            ctaUrl: `${portal}/tickets`,
            name: itAdmin.name,
            details: ticketDetails(updated),
            event: 'ticket.assigned',
            vars: ticketVars(updated, { recipientRole: 'IT Admin' }),
          });
          notified.add(itEmail);
        }
      }

      const assigneeEmail = await resolveAssigneeEmail(assigneeLabel);
      if (assigneeEmail && !notified.has(assigneeEmail)) {
        await notifyUser({
          targetEmail: assigneeEmail,
          subject: `Ticket ${ticket.public_id} assigned to you`,
          title: 'New ticket assigned',
          text: `Ticket ${ticket.public_id} "${updated.subject}" was assigned to you. Priority: ${priority}.`,
          type: 'warning',
          ctaLabel: 'Open ticket',
          ctaUrl: `${portal}/tickets`,
          details: ticketDetails(updated),
          event: 'ticket.assigned',
          vars: ticketVars(updated, { recipientRole: 'Assignee' }),
        });
      }

      return res.json({ success: true, data: await withReplies(updated) });
    }

    if (action === 'reject') {
      const reason = (body.reason || body.rejection_reason || '').trim();
      if (!reason) {
        return res.status(400).json({
          success: false,
          message: 'reason is required when rejecting',
        });
      }

      let priorityUpdate = ticket.priority;
      if (body.priority != null && String(body.priority).trim() !== '') {
        const p = String(body.priority).trim();
        if (!VALID_PRIORITIES.includes(p)) {
          return res.status(400).json({
            success: false,
            message: 'priority must be High, Medium, or Low when provided',
          });
        }
        priorityUpdate = p;
      }

      const result = await db.query(
        `UPDATE tickets SET
           status = $2, priority = COALESCE($3, priority),
           priority_set_by = COALESCE($4, priority_set_by),
           hold_reason = $5, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          ticket.id, TICKET_STATUS.REJECTED, priorityUpdate,
          body.priority ? req.authz.user.id : null, reason,
        ]
      );
      const updated = result.rows[0];
      const replyText = `[REJECTED BY LINE MANAGER] ${req.authz.user.name}: ${reason}`;

      await db.query(
        'INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, $2, $3, $4)',
        [ticket.id, req.authz.user.name, roleLabel(req), replyText]
      );

      await addAuditLog({
        user: actor(req),
        action: 'Ticket Rejected',
        details: `Line Manager rejected ${ticket.public_id}: ${reason}`,
        targetId: ticket.public_id,
      });

      await notifyUser({
        targetEmail: ticket.requester_email,
        subject: `Ticket ${ticket.public_id} rejected`,
        title: 'Ticket rejected by Line Manager',
        text: `Your ticket ${ticket.public_id} was rejected by your Line Manager. Reason: ${reason}`,
        type: 'warning',
        ctaLabel: 'View ticket',
        ctaUrl: `${portal}/tickets`,
        name: ticket.requester_name,
        details: ticketDetails(updated, {
          status: TICKET_STATUS.REJECTED,
          holdReason: reason,
          updatedBy: req.authz.user.name,
        }),
        event: 'ticket.rejected',
        vars: ticketVars(updated, {
          status: TICKET_STATUS.REJECTED,
          holdReason: reason,
          updatedBy: req.authz.user.name,
        }),
      });

      return res.json({ success: true, data: await withReplies(updated) });
    }

    return res.status(400).json({
      success: false,
      message: "action must be 'send_to_it' or 'reject'",
    });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!isItAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: 'Only IT Admin can update tickets. Other roles have view-only access.',
      });
    }
    if (isPendingLineManager(ticket)) {
      return res.status(403).json({
        success: false,
        message: 'IT Admin cannot update tickets while Pending Line Manager. View only until Line Manager sends to IT.',
      });
    }

    const {
      subject, category, other_category, department, priority,
      description, assigned_to, attachment_url, status,
    } = req.body;

    let due_timestamp = ticket.due_timestamp;
    if (priority && priority !== ticket.priority) {
      due_timestamp = new Date(Date.now() + slaHours(priority) * 60 * 60 * 1000);
    }

    const result = await db.query(
      `UPDATE tickets SET
         subject = COALESCE($2, subject), category = COALESCE($3, category),
         other_category = COALESCE($4, other_category), department = COALESCE($5, department),
         priority = COALESCE($6, priority), description = COALESCE($7, description),
         assigned_to = COALESCE($8, assigned_to), attachment_url = COALESCE($9, attachment_url),
         status = COALESCE($10, status), due_timestamp = COALESCE($11, due_timestamp),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        ticket.id, subject, category, other_category, department, priority,
        description, assigned_to, attachment_url, status, due_timestamp,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Updated Ticket',
      details: `Updated ticket ${ticket.public_id}`,
      targetId: ticket.public_id,
    });

    const updated = result.rows[0];
    const portal = portalBase();

    if (assigned_to && assigned_to !== ticket.assigned_to) {
      await notifyUser({
        targetEmail: ticket.requester_email,
        subject: `Ticket ${ticket.public_id} reassigned`,
        title: 'Ticket assignment updated',
        text: `Your ticket ${ticket.public_id} is now assigned to ${assigned_to}.`,
        type: 'info',
        ctaLabel: 'View ticket',
        ctaUrl: `${portal}/tickets`,
        details: ticketDetails(updated, {
          previousAssignee: ticket.assigned_to,
          updatedBy: req.authz.user.name,
        }),
        event: 'ticket.assigned',
        vars: ticketVars(updated, {
          previousAssignee: ticket.assigned_to,
          updatedBy: req.authz.user.name,
        }),
      });

      const assigneeEmail = await resolveAssigneeEmail(assigned_to);
      if (assigneeEmail) {
        await notifyUser({
          targetEmail: assigneeEmail,
          subject: `Ticket ${ticket.public_id} assigned to you`,
          title: 'Ticket assigned to you',
          text: `Ticket ${ticket.public_id} "${updated.subject}" was assigned to you.`,
          type: 'warning',
          ctaLabel: 'Open ticket',
          ctaUrl: `${portal}/tickets`,
          details: ticketDetails(updated, {
            previousAssignee: ticket.assigned_to,
            updatedBy: req.authz.user.name,
          }),
          event: 'ticket.assigned',
          vars: ticketVars(updated, {
            previousAssignee: ticket.assigned_to,
            updatedBy: req.authz.user.name,
          }),
        });
      }
    }

    return res.json({ success: true, data: await withReplies(updated) });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!isItAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only IT Admin can delete tickets' });
    }
    await db.query('DELETE FROM tickets WHERE id = $1', [ticket.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Ticket',
      details: `Deleted ticket ${ticket.public_id}`,
      targetId: ticket.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

async function setStatus(req, res, next, status, replyText, holdReason) {
  const ticket = await findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
  if (!isItAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: 'Only IT Admin can change ticket status',
    });
  }
  if (isPendingLineManager(ticket)) {
    return res.status(403).json({
      success: false,
      message: 'IT Admin cannot change status while Pending Line Manager. View only until Line Manager sends to IT.',
    });
  }

  const result = await db.query(
    `UPDATE tickets SET status = $2, hold_reason = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [ticket.id, status, holdReason === undefined ? ticket.hold_reason : holdReason]
  );

  if (replyText) {
    await db.query(
      'INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, $2, $3, $4)',
      [ticket.id, req.authz.user.name, roleLabel(req), replyText]
    );
  }

  await addAuditLog({
    user: actor(req),
    action: `Ticket ${status}`,
    details: replyText || `Ticket ${ticket.public_id} set to ${status}`,
    targetId: ticket.public_id,
  });

  await notifyUser({
    targetEmail: ticket.requester_email,
    subject: `Ticket ${ticket.public_id}: ${status}`,
    title: `Ticket status: ${status}`,
    text: replyText || `Your ticket ${ticket.public_id} status is now ${status}.`,
    type: status === 'Resolved' ? 'success' : status.toLowerCase().includes('hold') ? 'warning' : 'info',
    ctaLabel: 'View ticket',
    ctaUrl: `${portalBase()}/tickets`,
    details: ticketDetails(result.rows[0] || ticket, {
      status,
      holdReason: holdReason === undefined ? ticket.hold_reason : holdReason,
      updatedBy: req.authz.user.name,
      replyText,
    }),
    event: 'ticket.status_changed',
    vars: ticketVars(result.rows[0] || ticket, {
      status,
      holdReason: holdReason === undefined ? ticket.hold_reason : holdReason,
      updatedBy: req.authz.user.name,
      replyText,
    }),
  });

  return res.json({ success: true, data: await withReplies(result.rows[0]) });
}

async function inProgress(req, res, next) {
  try {
    return await setStatus(
      req, res, next, TICKET_STATUS.IN_PROGRESS,
      'IT Support marked ticket In Progress and is actively working on it.', null
    );
  } catch (err) {
    return next(err);
  }
}

async function hold(req, res, next) {
  try {
    const body = req.body || {};
    const reason = body.reason || body.hold_reason || body.holdReason;
    if (!reason) {
      return res.status(400).json({ success: false, message: 'reason is required' });
    }
    return await setStatus(
      req, res, next, TICKET_STATUS.ON_HOLD,
      `[TICKET PUT ON HOLD] Reason: ${reason}`, reason
    );
  } catch (err) {
    return next(err);
  }
}

async function resume(req, res, next) {
  try {
    return await setStatus(
      req, res, next, TICKET_STATUS.IN_PROGRESS,
      'IT Support resumed work on ticket from hold status.', null
    );
  } catch (err) {
    return next(err);
  }
}

async function resolve(req, res, next) {
  try {
    const body = req.body || {};
    const note = body.note || body.resolution || 'Ticket marked resolved';
    return await setStatus(
      req, res, next, TICKET_STATUS.RESOLVED,
      `Ticket marked resolved: ${note}`, null
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
    const ticket = await findTicket(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (!canAccessTicket(req, ticket)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    await db.query(
      'INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, $2, $3, $4)',
      [ticket.id, req.authz.user.name, roleLabel(req), text.trim()]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Ticket Reply',
      details: `Replied on ${ticket.public_id}`,
      targetId: ticket.public_id,
    });

    const notifyEmail =
      (ticket.requester_email || '').toLowerCase() === (req.authz.user.email || '').toLowerCase()
        ? null
        : ticket.requester_email;

    if (notifyEmail) {
      await notifyUser({
        targetEmail: notifyEmail,
        subject: `Reply on Ticket ${ticket.public_id}`,
        title: 'New reply on your ticket',
        text: `${req.authz.user.name} replied on ticket ${ticket.public_id}: ${text.trim()}`,
        type: 'info',
        ctaLabel: 'View ticket',
        ctaUrl: `${portalBase()}/tickets`,
        details: ticketDetails(ticket, {
          repliedBy: req.authz.user.name,
          replyMessage: text.trim(),
        }),
        event: 'ticket.reply',
        vars: ticketVars(ticket, {
          repliedBy: req.authz.user.name,
          replyMessage: text.trim(),
        }),
      });
    }

    return res.json({ success: true, data: await withReplies(ticket) });
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
  lineManagerReview,
  inProgress,
  hold,
  resume,
  resolve,
  reply,
};
