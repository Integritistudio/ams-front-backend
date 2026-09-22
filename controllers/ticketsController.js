const db = require('../config/database');
const Role = require('../models/Role');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');

const TICKET_SLA = { High: 4, Medium: 24, Low: 48 };

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function roleLabel(req) {
  return req.authz?.role?.name || 'User';
}

function slaHours(priority) {
  return TICKET_SLA[priority] || TICKET_SLA.Medium;
}

async function findTicket(idOrPublic) {
  const key = String(idOrPublic);
  const byId = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM tickets WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM tickets WHERE public_id = $1`, [key]);
  return byId.rows[0] || null;
}

async function loadReplies(ticketId) {
  const result = await db.query(
    `SELECT * FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketId]
  );
  return result.rows;
}

async function withReplies(ticket) {
  if (!ticket) return null;
  return { ...ticket, replies: await loadReplies(ticket.id) };
}

function canAccessTicket(req, ticket) {
  if (canViewAll('tickets')(req)) return true;
  return (
    (ticket.requester_email || '').toLowerCase() ===
    (req.authz.user.email || '').toLowerCase()
  );
}

async function list(req, res, next) {
  try {
    let result;
    if (canViewAll('tickets')(req)) {
      result = await db.query(`SELECT * FROM tickets ORDER BY created_timestamp DESC`);
    } else {
      result = await db.query(
        `SELECT * FROM tickets WHERE LOWER(requester_email) = LOWER($1)
         ORDER BY created_timestamp DESC`,
        [req.authz.user.email]
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
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
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
      requester_name,
      requester_email,
      subject,
      category,
      other_category,
      department,
      priority,
      description,
      assigned_to,
      attachment_url,
      on_behalf,
    } = req.body;

    if (!subject) {
      return res.status(400).json({ success: false, message: 'subject is required' });
    }

    const defaultName = req.authz.user.name;
    const defaultEmail = (req.authz.user.email || '').toLowerCase();
    const mayBehalf = canViewAll('tickets')(req);
    const name = mayBehalf && requester_name ? requester_name : defaultName;
    const email = (mayBehalf && requester_email ? requester_email : defaultEmail).toLowerCase();
    const isBehalf =
      Boolean(on_behalf) &&
      mayBehalf &&
      email !== defaultEmail;
    const prio = priority || 'Medium';
    const hours = slaHours(prio);
    const due = new Date(Date.now() + hours * 60 * 60 * 1000);
    const pid = publicId('TKT');

    let requesterId = req.authz.user.id;
    if (isBehalf) {
      const uRes = await db.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      );
      if (uRes.rows[0]) requesterId = uRes.rows[0].id;
    }

    let assigneeLabel = assigned_to || null;
    if (!assigneeLabel) {
      const itAdmin = await Role.findDesignatedUser('is_it_admin');
      assigneeLabel = itAdmin
        ? (itAdmin.email || itAdmin.name)
        : 'IT Support';
    }

    const result = await db.query(
      `INSERT INTO tickets (
         public_id, requester_id, requester_name, requester_email, subject,
         category, other_category, department, priority, status, description,
         assigned_to, attachment_url, due_timestamp
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Assigned',$10,$11,$12,$13)
       RETURNING *`,
      [
        pid,
        requesterId,
        name,
        email,
        subject,
        category || null,
        other_category || null,
        department || req.authz.user.department || null,
        prio,
        description || null,
        assigneeLabel,
        attachment_url || null,
        due,
      ]
    );

    const ticket = result.rows[0];
    const behalfNote = isBehalf
      ? `Ticket opened by IT Admin (${req.authz.user.name}) on behalf of user ${name}.`
      : `Ticket created. Committed SLA: ${hours} hours. Assigned to ${ticket.assigned_to}.`;

    await db.query(
      `INSERT INTO ticket_replies (ticket_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [ticket.id, 'System', 'System', behalfNote]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Created Ticket',
      details: isBehalf
        ? `Created ticket ${ticket.public_id} on behalf of ${name}`
        : `Created ticket ${ticket.public_id} with ${hours}h SLA`,
      targetId: ticket.public_id,
    });

    await notifyUser({
      targetEmail: email,
      subject: `Ticket ${ticket.public_id} created`,
      title: 'Support ticket created',
      text: `Your ticket "${subject}" (${ticket.public_id}) was submitted and assigned to ${ticket.assigned_to}. Priority: ${ticket.priority}.`,
      type: 'info',
      ctaLabel: 'View tickets',
      ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/tickets`,
    });

    if (ticket.assigned_to && String(ticket.assigned_to).includes('@')) {
      await notifyUser({
        targetEmail: ticket.assigned_to,
        subject: `Ticket ${ticket.public_id} assigned to you`,
        title: 'New ticket assigned',
        text: `Ticket ${ticket.public_id} "${subject}" was assigned to you. Priority: ${ticket.priority}.`,
        type: 'warning',
        ctaLabel: 'Open ticket',
        ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/tickets`,
      });
    } else if (ticket.assigned_to && ticket.assigned_to !== 'IT Support') {
      const assignee = await db.query(
        `SELECT email FROM users WHERE LOWER(name) = LOWER($1) AND status = 'Active' LIMIT 1`,
        [ticket.assigned_to]
      );
      if (assignee.rows[0]?.email) {
        await notifyUser({
          targetEmail: assignee.rows[0].email,
          subject: `Ticket ${ticket.public_id} assigned to you`,
          title: 'New ticket assigned',
          text: `Ticket ${ticket.public_id} "${subject}" was assigned to you. Priority: ${ticket.priority}.`,
          type: 'warning',
          ctaLabel: 'Open ticket',
          ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/tickets`,
        });
      }
    }

    return res.status(201).json({ success: true, data: await withReplies(ticket) });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    if (!canAccessTicket(req, ticket) && !canViewAll('tickets')(req)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const {
      subject,
      category,
      other_category,
      department,
      priority,
      description,
      assigned_to,
      attachment_url,
      status,
    } = req.body;

    let due_timestamp = ticket.due_timestamp;
    if (priority && priority !== ticket.priority) {
      due_timestamp = new Date(Date.now() + slaHours(priority) * 60 * 60 * 1000);
    }

    const result = await db.query(
      `UPDATE tickets SET
         subject = COALESCE($2, subject),
         category = COALESCE($3, category),
         other_category = COALESCE($4, other_category),
         department = COALESCE($5, department),
         priority = COALESCE($6, priority),
         description = COALESCE($7, description),
         assigned_to = COALESCE($8, assigned_to),
         attachment_url = COALESCE($9, attachment_url),
         status = COALESCE($10, status),
         due_timestamp = COALESCE($11, due_timestamp),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        ticket.id,
        subject,
        category,
        other_category,
        department,
        priority,
        description,
        assigned_to,
        attachment_url,
        status,
        due_timestamp,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Updated Ticket',
      details: `Updated ticket ${ticket.public_id}`,
      targetId: ticket.public_id,
    });

    const updated = result.rows[0];
    const portal = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');

    if (assigned_to && assigned_to !== ticket.assigned_to) {
      await notifyUser({
        targetEmail: ticket.requester_email,
        subject: `Ticket ${ticket.public_id} reassigned`,
        title: 'Ticket assignment updated',
        text: `Your ticket ${ticket.public_id} is now assigned to ${assigned_to}.`,
        type: 'info',
        ctaLabel: 'View ticket',
        ctaUrl: `${portal}/tickets`,
      });

      let assigneeEmail = null;
      if (String(assigned_to).includes('@')) {
        assigneeEmail = assigned_to;
      } else {
        const assignee = await db.query(
          `SELECT email FROM users WHERE LOWER(name) = LOWER($1) AND status = 'Active' LIMIT 1`,
          [assigned_to]
        );
        assigneeEmail = assignee.rows[0]?.email || null;
      }
      if (assigneeEmail) {
        await notifyUser({
          targetEmail: assigneeEmail,
          subject: `Ticket ${ticket.public_id} assigned to you`,
          title: 'Ticket assigned to you',
          text: `Ticket ${ticket.public_id} "${updated.subject}" was assigned to you.`,
          type: 'warning',
          ctaLabel: 'Open ticket',
          ctaUrl: `${portal}/tickets`,
        });
      }
    }

    return res.json({ success: true, data: await withReplies(updated) });  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    if (!canViewAll('tickets')(req)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    await db.query(`DELETE FROM tickets WHERE id = $1`, [ticket.id]);
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
  if (!ticket) {
    return res.status(404).json({ success: false, message: 'Ticket not found' });
  }
  if (!canViewAll('tickets')(req)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const result = await db.query(
    `UPDATE tickets SET
       status = $2,
       hold_reason = $3,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [ticket.id, status, holdReason === undefined ? ticket.hold_reason : holdReason]
  );

  if (replyText) {
    await db.query(
      `INSERT INTO ticket_replies (ticket_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
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
    ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/tickets`,
  });

  return res.json({ success: true, data: await withReplies(result.rows[0]) });
}

async function inProgress(req, res, next) {
  try {
    return await setStatus(
      req,
      res,
      next,
      'In Progress',
      'IT Support marked ticket In Progress and is actively working on it.',
      null
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
      req,
      res,
      next,
      'On Hold',
      `[TICKET PUT ON HOLD] Reason: ${reason}`,
      reason
    );
  } catch (err) {
    return next(err);
  }
}

async function resume(req, res, next) {
  try {
    return await setStatus(
      req,
      res,
      next,
      'In Progress',
      'IT Support resumed work on ticket from hold status.',
      null
    );
  } catch (err) {
    return next(err);
  }
}

async function resolve(req, res, next) {
  try {
    const body = req.body || {};
    const note = body.note || body.resolution || 'Ticket marked resolved';
    return await setStatus(req, res, next, 'Resolved', `Ticket marked resolved: ${note}`, null);
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
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    if (!canAccessTicket(req, ticket)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    await db.query(
      `INSERT INTO ticket_replies (ticket_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [ticket.id, req.authz.user.name, roleLabel(req), text.trim()]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Ticket Reply',
      details: `Replied on ${ticket.public_id}`,
      targetId: ticket.public_id,
    });

    const notifyEmail =
      (ticket.requester_email || '').toLowerCase() ===
      (req.authz.user.email || '').toLowerCase()
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
        ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/tickets`,
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
  inProgress,
  hold,
  resume,
  resolve,
  reply,
};
