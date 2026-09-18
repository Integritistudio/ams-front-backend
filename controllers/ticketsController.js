const db = require('../config/database');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog, addNotification, publicId } = require('../services/auditService');

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
    } = req.body;

    if (!subject) {
      return res.status(400).json({ success: false, message: 'subject is required' });
    }

    const name = requester_name || req.authz.user.name;
    const email = (requester_email || req.authz.user.email || '').toLowerCase();
    const prio = priority || 'Medium';
    const hours = slaHours(prio);
    const due = new Date(Date.now() + hours * 60 * 60 * 1000);
    const pid = publicId('TKT');

    const result = await db.query(
      `INSERT INTO tickets (
         public_id, requester_id, requester_name, requester_email, subject,
         category, other_category, department, priority, status, description,
         assigned_to, attachment_url, due_timestamp
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Assigned',$10,$11,$12,$13)
       RETURNING *`,
      [
        pid,
        req.authz.user.id,
        name,
        email,
        subject,
        category || null,
        other_category || null,
        department || req.authz.user.department || null,
        prio,
        description || null,
        assigned_to || 'IT Support',
        attachment_url || null,
        due,
      ]
    );

    const ticket = result.rows[0];
    await db.query(
      `INSERT INTO ticket_replies (ticket_id, author, role_label, text)
       VALUES ($1, $2, $3, $4)`,
      [
        ticket.id,
        'System',
        'System',
        `Ticket created. Committed SLA: ${hours} hours. Assigned to ${ticket.assigned_to}.`,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Created Ticket',
      details: `Created ticket ${ticket.public_id} with ${hours}h SLA`,
      targetId: ticket.public_id,
    });

    await addNotification({
      targetEmail: email,
      subject: `Ticket ${ticket.public_id} created`,
      text: `Your ticket "${subject}" was submitted and assigned.`,
      type: 'info',
    });

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

    return res.json({ success: true, data: await withReplies(result.rows[0]) });
  } catch (err) {
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

  await addNotification({
    targetEmail: ticket.requester_email,
    subject: `Ticket ${ticket.public_id}: ${status}`,
    text: replyText || `Your ticket status is now ${status}.`,
    type: status === 'Resolved' ? 'success' : 'info',
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
    const reason = req.body.reason || req.body.hold_reason;
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
    const note = req.body.note || req.body.resolution || 'Ticket marked resolved';
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
      await addNotification({
        targetEmail: notifyEmail,
        subject: `Reply on Ticket ${ticket.public_id}`,
        text: `New reply from ${req.authz.user.name}`,
        type: 'info',
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
