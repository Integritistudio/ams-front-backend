const db = require('../config/database');
const Role = require('../models/Role');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');
const { ticketDetails, ticketVars } = require('../services/emailDetails');
const { TICKET_STATUS } = require('../services/workflowConstants');
const flow = require('../services/ticketWorkflow');
const { isSuperAdmin } = require('../services/permissionService');

const ACTIVE = 'deleted_at IS NULL';

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function roleLabel(req) {
  return req.authz?.role?.name || 'User';
}

function portalBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function isItAdmin(req) {
  return Boolean(req.authz?.role?.is_it_admin);
}

function isExecutive(req) {
  return Boolean(req.authz?.role?.is_executive);
}

function flowUser(req) {
  return { id: req.authz?.user?.id, is_it_admin: isItAdmin(req) };
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

async function findTicket(idOrPublic) {
  const key = String(idOrPublic);
  const byId = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM tickets WHERE id = $1 AND ${ACTIVE}`, [key])
    : await db.query(`SELECT * FROM tickets WHERE public_id = $1 AND ${ACTIVE}`, [key]);
  return byId.rows[0] || null;
}

async function withThread(ticket) {
  if (!ticket) return null;
  const [replies, history] = await Promise.all([
    db.query('SELECT * FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]),
    db.query('SELECT * FROM ticket_status_history WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC', [ticket.id]),
  ]);
  return { ...ticket, replies: replies.rows, status_history: history.rows };
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
  return Boolean(userId && ticket?.line_manager_id && Number(ticket.line_manager_id) === userId);
}

function canAccessTicket(req, ticket) {
  if (canViewAllTickets(req)) return true;
  if (isTicketLineManager(req, ticket)) return true;
  if (ticket.assigned_to_id && Number(ticket.assigned_to_id) === Number(req.authz.user.id)) return true;
  return (ticket.requester_email || '').toLowerCase() === (req.authz.user.email || '').toLowerCase();
}

async function addReply(ticketId, author, role, text) {
  await db.query(
    'INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, $2, $3, $4)',
    [ticketId, author, role, text]
  );
}

async function recordHistory(ticketId, fromStatus, toStatus, by, note) {
  await db.query(
    `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by_id, changed_by_name, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ticketId, fromStatus, toStatus, by?.id || null, by?.name || 'System', note || null]
  );
}

/**
 * Move a ticket from `fromStatus` to `toStatus`, setting extra columns.
 * The update only applies while the ticket is still at `fromStatus` (guards against two people
 * acting at once); returns null when someone else changed it first.
 */
async function transition(ticket, fromStatus, toStatus, by, note, sets = {}) {
  const cols = ['status = $3', 'updated_at = NOW()'];
  const params = [ticket.id, fromStatus, toStatus];
  for (const [col, value] of Object.entries(sets)) {
    params.push(value);
    cols.push(`${col} = $${params.length}`);
  }
  const result = await db.query(
    `UPDATE tickets SET ${cols.join(', ')} WHERE id = $1 AND status = $2 AND ${ACTIVE} RETURNING *`,
    params
  );
  const updated = result.rows[0] || null;
  if (updated && fromStatus !== toStatus) await recordHistory(ticket.id, fromStatus, toStatus, by, note);
  return updated;
}

function conflict(res) {
  return fail(res, 409, 'This ticket was already updated by someone else. Refresh and try again.');
}

async function itAdmins() {
  return Role.findUsersWithFlag('is_it_admin');
}

async function notifyItTriage(ticket, excludeEmails = []) {
  const skip = new Set(excludeEmails.map((e) => String(e || '').toLowerCase()));
  for (const admin of await itAdmins()) {
    if (!admin?.email || skip.has(String(admin.email).toLowerCase())) continue;
    await notifyUser({
      targetEmail: admin.email,
      name: admin.name,
      subject: `Ticket ${ticket.public_id} needs triage`,
      title: 'Support ticket awaiting IT triage',
      text: `Ticket ${ticket.public_id} "${ticket.subject}" is waiting for Admin/IT to review and assign it.${
        ticket.priority ? ` Priority: ${ticket.priority}.` : ' Priority not set yet (no Line Manager).'
      }`,
      type: 'warning',
      ctaLabel: 'Open tickets',
      ctaUrl: `${portalBase()}/tickets`,
      details: ticketDetails(ticket),
      event: 'ticket.pending_triage',
      vars: ticketVars(ticket, { recipientRole: 'IT Admin' }),
    });
  }
}

async function notifyRequesterStatus(ticket, by, text, extras = {}) {
  await notifyUser({
    targetEmail: ticket.requester_email,
    name: ticket.requester_name,
    subject: extras.subject || `Ticket ${ticket.public_id}: ${ticket.status}`,
    title: extras.title || `Ticket status: ${ticket.status}`,
    text,
    type: extras.type || 'info',
    ctaLabel: 'View ticket',
    ctaUrl: `${portalBase()}/tickets`,
    details: ticketDetails(ticket, { updatedBy: by?.name, replyText: extras.note, holdReason: extras.holdReason }),
    event: extras.event || 'ticket.status_changed',
    vars: ticketVars(ticket, { updatedBy: by?.name, replyText: extras.note, holdReason: extras.holdReason }),
  });
}

async function insertTicket(values) {
  // public_id = timestamp (s) + 2 random digits; retry on the rare collision instead of failing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await db.query(
        `INSERT INTO tickets (
           public_id, requester_id, requester_name, requester_email, subject,
           category, other_category, department, priority, status, description,
           assigned_to, attachment_url, due_timestamp, line_manager_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,NULL,$11,NULL,$12)
         RETURNING *`,
        [publicId('TKT'), ...values]
      );
      return result.rows[0];
    } catch (err) {
      if (err.code !== '23505' || attempt === 4) throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function list(req, res, next) {
  try {
    const result = canViewAllTickets(req)
      ? await db.query(`SELECT * FROM tickets WHERE ${ACTIVE} ORDER BY created_timestamp DESC`)
      : await db.query(
        `SELECT * FROM tickets
         WHERE ${ACTIVE}
           AND (LOWER(requester_email) = LOWER($1) OR line_manager_id = $2 OR assigned_to_id = $2)
         ORDER BY created_timestamp DESC`,
        [req.authz.user.email, req.authz.user.id]
      );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'Ticket not found');
    if (!canAccessTicket(req, ticket)) return fail(res, 403, 'Access denied');
    return res.json({ success: true, data: await withThread(ticket) });
  } catch (err) {
    return next(err);
  }
}

/** IT resources a ticket can be assigned to (active Admin/IT users). */
async function assignees(req, res, next) {
  try {
    if (!isItAdmin(req)) return fail(res, 403, 'Only Admin/IT can assign tickets.');
    const users = (await itAdmins()).map((u) => ({ id: u.id, name: u.name, email: u.email }));
    return res.json({ success: true, data: users });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Step 1: creation
// ---------------------------------------------------------------------------

async function create(req, res, next) {
  try {
    if (isSuperAdmin(req)) return fail(res, 403, 'Super Admin cannot create support tickets.');
    const body = req.body || {};
    const errors = flow.validateNewTicket(body);
    if (errors.length) return fail(res, 400, errors.join('; '));

    const defaultName = req.authz.user.name;
    const defaultEmail = (req.authz.user.email || '').toLowerCase();
    const mayBehalf = isItAdmin(req);
    const name = mayBehalf && body.requester_name ? body.requester_name : defaultName;
    const email = (mayBehalf && body.requester_email ? body.requester_email : defaultEmail).toLowerCase();
    const isBehalf = Boolean(body.on_behalf) && mayBehalf && email !== defaultEmail;

    let requesterId = req.authz.user.id;
    if (isBehalf) {
      const uRes = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
      if (!uRes.rows[0]) return fail(res, 400, `No user found with email ${email}.`);
      requesterId = uRes.rows[0].id;
    }

    // Priority is set by the Line Manager (or by Admin/IT at triage when there is no Line Manager);
    // any priority sent by the requester is ignored.
    const lmRes = await db.query(
      `SELECT m.id, m.name, m.email
       FROM users u JOIN users m ON m.id = u.manager_id
       WHERE u.id = $1 AND m.status = 'Active' AND m.deleted_at IS NULL AND m.id <> u.id`,
      [requesterId]
    );
    const lm = lmRes.rows[0] || null;
    const status = flow.initialStatus(lm?.id);
    const category = String(body.category).trim();

    const ticket = await insertTicket([
      requesterId,
      name,
      email,
      String(body.subject).trim(),
      category,
      category === flow.OTHER_CATEGORY ? String(body.other_category).trim() : null,
      body.department || req.authz.user.department || null,
      status,
      String(body.description).trim(),
      body.attachment_url || null,
      lm?.id || null,
    ]);

    const routeNote = lm
      ? `Awaiting Line Manager (${lm.name}) to set priority.`
      : 'No Line Manager configured — sent straight to IT triage; Admin/IT will set the priority.';
    await recordHistory(ticket.id, null, status, req.authz.user, isBehalf ? `Created on behalf of ${name}. ${routeNote}` : `Created. ${routeNote}`);
    await addReply(
      ticket.id,
      'System',
      'System',
      isBehalf ? `Ticket opened by ${req.authz.user.name} on behalf of ${name}. ${routeNote}` : `Ticket created. ${routeNote}`
    );
    await addAuditLog({
      user: actor(req),
      action: 'Created Ticket',
      details: `Created ticket ${ticket.public_id}${isBehalf ? ` on behalf of ${name}` : ''} (${status})`,
      targetId: ticket.public_id,
    });

    const portal = portalBase();
    await notifyUser({
      targetEmail: email,
      subject: `Ticket ${ticket.public_id} created`,
      title: 'Support ticket created',
      text: `Your ticket "${ticket.subject}" (${ticket.public_id}) was submitted. ${routeNote}`,
      type: 'info',
      ctaLabel: 'View tickets',
      ctaUrl: `${portal}/tickets`,
      name,
      details: ticketDetails(ticket),
      event: 'ticket.created',
      vars: ticketVars(ticket, { recipientRole: 'Requester' }),
    });

    if (lm) {
      if (String(lm.email || '').toLowerCase() !== email) {
        await notifyUser({
          targetEmail: lm.email,
          name: lm.name,
          subject: `Ticket ${ticket.public_id} needs your review`,
          title: 'Support ticket pending Line Manager review',
          text: `Ticket ${ticket.public_id} "${ticket.subject}" was submitted by ${name} and needs you to set its priority or reject it.`,
          type: 'warning',
          ctaLabel: 'Review ticket',
          ctaUrl: `${portal}/tickets`,
          details: ticketDetails(ticket),
          event: 'ticket.pending_line_manager',
          vars: ticketVars(ticket, { recipientRole: 'Line Manager' }),
        });
      }
    } else {
      await notifyItTriage(ticket, [email]);
    }

    return res.status(201).json({ success: true, data: await withThread(ticket) });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Line Manager priority (or rejection)
// ---------------------------------------------------------------------------

async function lineManagerReview(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'Ticket not found');
    if (ticket.status !== TICKET_STATUS.PENDING_LINE_MANAGER) {
      return fail(res, 409, 'Ticket is not pending Line Manager review');
    }
    if (!isTicketLineManager(req, ticket)) {
      return fail(res, 403, 'Only the assigned Line Manager can review this ticket');
    }

    const body = req.body || {};
    const action = String(body.action || '').trim().toLowerCase();
    const by = req.authz.user;

    if (action === 'send_to_it') {
      const priority = String(body.priority || '').trim();
      if (!flow.isPriority(priority)) {
        return fail(res, 400, 'priority is required (High, Medium, or Low) when sending to IT');
      }
      const hours = flow.slaHours(priority);
      const note = `Line Manager ${by.name} set priority to ${priority} (SLA ${hours}h) and sent the ticket to IT triage.`;
      const updated = await transition(ticket, ticket.status, TICKET_STATUS.PENDING_TRIAGE, by, note, {
        priority,
        priority_set_by: by.id,
        due_timestamp: new Date(Date.now() + hours * 60 * 60 * 1000),
      });
      if (!updated) return conflict(res);

      await addReply(ticket.id, by.name, roleLabel(req), note);
      await addAuditLog({
        user: actor(req),
        action: 'Ticket Priority Set',
        details: `Line Manager set ${ticket.public_id} priority to ${priority} (${hours}h SLA); sent to IT triage`,
        targetId: ticket.public_id,
      });
      await notifyRequesterStatus(updated, by, `Your ticket ${ticket.public_id} was reviewed by your Line Manager (priority ${priority}) and sent to IT.`, {
        subject: `Ticket ${ticket.public_id} sent to IT`,
        title: 'Ticket prioritized and sent to IT',
        event: 'ticket.sent_to_it',
      });
      await notifyItTriage(updated, [ticket.requester_email]);
      return res.json({ success: true, data: await withThread(updated) });
    }

    if (action === 'reject') {
      const reason = String(body.reason || body.rejection_reason || '').trim();
      if (!reason) return fail(res, 400, 'reason is required when rejecting');
      const note = `Rejected by Line Manager ${by.name}: ${reason}`;
      const updated = await transition(ticket, ticket.status, TICKET_STATUS.REJECTED, by, note, { hold_reason: reason });
      if (!updated) return conflict(res);

      await addReply(ticket.id, by.name, roleLabel(req), `[REJECTED BY LINE MANAGER] ${reason}`);
      await addAuditLog({
        user: actor(req),
        action: 'Ticket Rejected',
        details: `Line Manager rejected ${ticket.public_id}: ${reason}`,
        targetId: ticket.public_id,
      });
      await notifyRequesterStatus(updated, by, `Your ticket ${ticket.public_id} was rejected by your Line Manager. Reason: ${reason}`, {
        subject: `Ticket ${ticket.public_id} rejected`,
        title: 'Ticket rejected by Line Manager',
        type: 'warning',
        event: 'ticket.rejected',
        holdReason: reason,
      });
      return res.json({ success: true, data: await withThread(updated) });
    }

    return fail(res, 400, "action must be 'send_to_it' or 'reject'");
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Step 3: triage and assignment (Admin/IT)
// ---------------------------------------------------------------------------

/** Body: { assignee_id, priority? } — priority is required (and only allowed) when none was set yet. */
async function assign(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    const check = flow.checkAction('assign', flowUser(req), ticket);
    if (!check.ok) return fail(res, check.status, check.message);

    const body = req.body || {};
    const assigneeId = Number(body.assignee_id);
    const assignee = (await itAdmins()).find((u) => Number(u.id) === assigneeId);
    if (!assignee) return fail(res, 400, 'assignee_id must be an active Admin/IT user');

    const sets = { assigned_to_id: assignee.id, assigned_to: assignee.email || assignee.name, assigned_at: new Date() };
    let priorityNote = '';
    if (!ticket.priority) {
      const priority = String(body.priority || '').trim();
      if (!flow.isPriority(priority)) {
        return fail(res, 400, 'priority (High, Medium, or Low) is required: this ticket had no Line Manager review');
      }
      const hours = flow.slaHours(priority);
      Object.assign(sets, {
        priority,
        priority_set_by: req.authz.user.id,
        due_timestamp: new Date(Date.now() + hours * 60 * 60 * 1000),
      });
      priorityNote = ` Priority set to ${priority} (SLA ${hours}h).`;
    } else if (body.priority && body.priority !== ticket.priority) {
      return fail(res, 400, 'Priority was set by the Line Manager and cannot be changed by Admin/IT.');
    }

    const by = req.authz.user;
    const reassigned = ticket.assigned_to_id != null;
    if (reassigned && Number(ticket.assigned_to_id) === assignee.id) {
      return fail(res, 400, `Ticket is already assigned to ${assignee.name}.`);
    }
    const note = `${reassigned ? 'Reassigned' : 'Assigned'} to ${assignee.name} by ${by.name}.${priorityNote}`;
    const updated = await transition(ticket, ticket.status, flow.assignTarget(ticket), by, note, sets);
    if (!updated) return conflict(res);
    // transition() only records status changes; a reassignment keeps the status, so log it here.
    if (ticket.status === updated.status) await recordHistory(ticket.id, ticket.status, updated.status, by, note);

    await addReply(ticket.id, by.name, roleLabel(req), note);
    await addAuditLog({
      user: actor(req),
      action: reassigned ? 'Ticket Reassigned' : 'Ticket Assigned',
      details: `${ticket.public_id}: ${note}`,
      targetId: ticket.public_id,
    });

    if (String(assignee.email || '').toLowerCase() !== String(by.email || '').toLowerCase()) {
      await notifyUser({
        targetEmail: assignee.email,
        name: assignee.name,
        subject: `Ticket ${ticket.public_id} assigned to you`,
        title: 'Ticket assigned to you',
        text: `Ticket ${ticket.public_id} "${updated.subject}" was assigned to you by ${by.name}. Priority: ${updated.priority}.`,
        type: 'warning',
        ctaLabel: 'Open ticket',
        ctaUrl: `${portalBase()}/tickets`,
        details: ticketDetails(updated, { previousAssignee: reassigned ? ticket.assigned_to : null, updatedBy: by.name }),
        event: 'ticket.assigned',
        vars: ticketVars(updated, { previousAssignee: ticket.assigned_to, updatedBy: by.name, recipientRole: 'Assignee' }),
      });
    }
    await notifyRequesterStatus(updated, by, `Your ticket ${ticket.public_id} is assigned to ${assignee.name}.`, {
      subject: `Ticket ${ticket.public_id} assigned`,
      title: 'Ticket assigned to IT',
      event: 'ticket.assigned',
    });
    return res.json({ success: true, data: await withThread(updated) });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Step 4: investigation and resolution (IT Assignee)
// ---------------------------------------------------------------------------

async function runAssigneeAction(req, res, next, action, { note, sets = {}, notifyText, notifyType, holdReason }) {
  try {
    const ticket = await findTicket(req.params.id);
    const check = flow.checkAction(action, flowUser(req), ticket);
    if (!check.ok) return fail(res, check.status, check.message);

    const by = req.authz.user;
    const updated = await transition(ticket, ticket.status, check.to, by, note, sets);
    if (!updated) return conflict(res);

    await addReply(ticket.id, by.name, roleLabel(req), note);
    await addAuditLog({ user: actor(req), action: `Ticket ${check.to}`, details: `${ticket.public_id}: ${note}`, targetId: ticket.public_id });
    const text = typeof notifyText === 'function' ? notifyText(updated) : notifyText || note;
    await notifyRequesterStatus(updated, by, text, { type: notifyType, note, holdReason });
    return res.json({ success: true, data: await withThread(updated) });
  } catch (err) {
    return next(err);
  }
}

function inProgress(req, res, next) {
  return runAssigneeAction(req, res, next, 'in_progress', {
    note: `${req.authz.user.name} started working on the ticket.`,
  });
}

function hold(req, res, next) {
  const body = req.body || {};
  const reason = String(body.reason || body.hold_reason || body.holdReason || '').trim();
  if (!reason) return fail(res, 400, 'reason is required');
  return runAssigneeAction(req, res, next, 'hold', {
    note: `[TICKET PUT ON HOLD] Reason: ${reason}`,
    sets: { hold_reason: reason },
    notifyType: 'warning',
    holdReason: reason,
  });
}

function resume(req, res, next) {
  return runAssigneeAction(req, res, next, 'resume', {
    note: `${req.authz.user.name} resumed work on the ticket.`,
    sets: { hold_reason: null },
  });
}

/** Body: { resolution } — the resolution details are mandatory. */
function resolve(req, res, next) {
  const body = req.body || {};
  const resolution = String(body.resolution || body.note || '').trim();
  if (!resolution) return fail(res, 400, 'resolution details are required');
  return runAssigneeAction(req, res, next, 'resolve', {
    note: `Resolved: ${resolution}`,
    sets: { resolution, resolved_at: new Date(), hold_reason: null },
    notifyType: 'success',
    notifyText: (t) => `Your ticket ${t.public_id} has been resolved: ${resolution}. Admin/IT will complete it shortly.`,
  });
}

// ---------------------------------------------------------------------------
// Step 5: completion (Admin/IT) + requester email
// ---------------------------------------------------------------------------

async function complete(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    const check = flow.checkAction('complete', flowUser(req), ticket);
    if (!check.ok) return fail(res, check.status, check.message);

    const by = req.authz.user;
    const extra = String(req.body?.note || '').trim();
    const note = `Completed by ${by.name}.${extra ? ` ${extra}` : ''}`;
    const updated = await transition(ticket, ticket.status, TICKET_STATUS.COMPLETED, by, note, {
      completed_at: new Date(),
      completed_by: by.id,
    });
    if (!updated) return conflict(res);

    await addReply(ticket.id, by.name, roleLabel(req), note);
    await addAuditLog({ user: actor(req), action: 'Ticket Completed', details: `${ticket.public_id}: ${note}`, targetId: ticket.public_id });
    await notifyRequesterStatus(
      updated,
      by,
      `Your ticket ${ticket.public_id} "${ticket.subject}" is completed.${ticket.resolution ? ` Resolution: ${ticket.resolution}` : ''}`,
      {
        subject: `Ticket ${ticket.public_id} completed`,
        title: 'Support ticket completed',
        type: 'success',
        event: 'ticket.completed',
        note: ticket.resolution,
      }
    );
    return res.json({ success: true, data: await withThread(updated) });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Edit details, soft delete, replies
// ---------------------------------------------------------------------------

/**
 * Admin/IT may correct the ticket's descriptive fields while it is being triaged or worked.
 * Status, priority and assignment only change through their workflow actions.
 */
async function update(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    const check = flow.checkAction('edit', flowUser(req), ticket);
    if (!check.ok) return fail(res, check.status, check.message);

    const body = req.body || {};
    for (const locked of ['status', 'priority', 'assigned_to', 'assigned_to_id']) {
      if (body[locked] !== undefined && body[locked] !== ticket[locked]) {
        return fail(res, 400, `${locked} can only be changed through the ticket workflow actions.`);
      }
    }
    for (const field of ['subject', 'category', 'description']) {
      if (body[field] !== undefined && !String(body[field]).trim()) return fail(res, 400, `${field} cannot be empty`);
    }

    const result = await db.query(
      `UPDATE tickets SET
         subject = COALESCE($2, subject), category = COALESCE($3, category),
         other_category = COALESCE($4, other_category), department = COALESCE($5, department),
         description = COALESCE($6, description), attachment_url = COALESCE($7, attachment_url),
         updated_at = NOW()
       WHERE id = $1 AND ${ACTIVE} RETURNING *`,
      [ticket.id, body.subject, body.category, body.other_category, body.department, body.description, body.attachment_url]
    );
    await addAuditLog({ user: actor(req), action: 'Updated Ticket', details: `Updated details of ticket ${ticket.public_id}`, targetId: ticket.public_id });
    return res.json({ success: true, data: await withThread(result.rows[0]) });
  } catch (err) {
    return next(err);
  }
}

/** Soft delete: the ticket, its history and audit trail are kept; it is hidden from lists. */
async function remove(req, res, next) {
  try {
    const ticket = await findTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'Ticket not found');
    if (!isItAdmin(req)) return fail(res, 403, 'Only IT Admin can delete tickets');
    await db.query('UPDATE tickets SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [ticket.id]);
    await recordHistory(ticket.id, ticket.status, ticket.status, req.authz.user, 'Ticket deleted (archived).');
    await addAuditLog({ user: actor(req), action: 'Deleted Ticket', details: `Archived ticket ${ticket.public_id}`, targetId: ticket.public_id });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

async function reply(req, res, next) {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return fail(res, 400, 'text is required');
    const ticket = await findTicket(req.params.id);
    if (!ticket) return fail(res, 404, 'Ticket not found');
    if (!canAccessTicket(req, ticket)) return fail(res, 403, 'Access denied');
    if (flow.CLOSED.includes(ticket.status)) return fail(res, 409, `Ticket is ${ticket.status}; replies are closed.`);

    await addReply(ticket.id, req.authz.user.name, roleLabel(req), text);
    await addAuditLog({ user: actor(req), action: 'Ticket Reply', details: `Replied on ${ticket.public_id}`, targetId: ticket.public_id });

    const me = String(req.authz.user.email || '').toLowerCase();
    const recipients = new Set([String(ticket.requester_email || '').toLowerCase()]);
    if (ticket.assigned_to_id) {
      const a = await db.query('SELECT email FROM users WHERE id = $1', [ticket.assigned_to_id]);
      if (a.rows[0]?.email) recipients.add(String(a.rows[0].email).toLowerCase());
    }
    recipients.delete(me);
    recipients.delete('');
    for (const targetEmail of recipients) {
      await notifyUser({
        targetEmail,
        subject: `Reply on Ticket ${ticket.public_id}`,
        title: 'New reply on ticket',
        text: `${req.authz.user.name} replied on ticket ${ticket.public_id}: ${text}`,
        type: 'info',
        ctaLabel: 'View ticket',
        ctaUrl: `${portalBase()}/tickets`,
        details: ticketDetails(ticket, { repliedBy: req.authz.user.name, replyMessage: text }),
        event: 'ticket.reply',
        vars: ticketVars(ticket, { repliedBy: req.authz.user.name, replyMessage: text }),
      });
    }
    return res.json({ success: true, data: await withThread(ticket) });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  get,
  assignees,
  create,
  update,
  remove,
  lineManagerReview,
  assign,
  inProgress,
  hold,
  resume,
  resolve,
  complete,
  reply,
};
