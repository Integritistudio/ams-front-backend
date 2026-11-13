/**
 * Line Manager routing for tickets and asset requests with on-leave forwarding.
 *  - resolveLineManager(): who approves the Line Manager step for a requester right now.
 *  - forwardWaitingFor(): when a manager switches to On Leave, move the tickets / asset requests
 *    waiting for them to the next available manager (or skip the Line Manager step).
 * Rules live in availability.js (pure, unit-tested).
 */
const db = require('../config/database');
const availability = require('./availability');
const { addAuditLog } = require('./auditService');
const { notifyUser } = require('./notifyService');
const { REQ_STATUS, TICKET_STATUS } = require('./workflowConstants');

const MANAGER_FIELDS = `id, name, email, status, manager_id, availability_status, availability_custom, availability_until`;

/** Managers above the requester, nearest first, at most MAX_LEVELS deep (stops on a loop). */
async function managerChain(requesterId) {
  if (!requesterId) return [];
  const result = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT m.${MANAGER_FIELDS.split(', ').join(', m.')}, 1 AS depth, ARRAY[u.id, m.id] AS path
       FROM users u JOIN users m ON m.id = u.manager_id
       WHERE u.id = $1
       UNION ALL
       SELECT m.${MANAGER_FIELDS.split(', ').join(', m.')}, c.depth + 1, c.path || m.id
       FROM chain c JOIN users m ON m.id = c.manager_id
       WHERE c.depth < $2 AND NOT m.id = ANY(c.path)
     )
     SELECT * FROM chain ORDER BY depth ASC`,
    [requesterId, availability.MAX_LEVELS]
  );
  return result.rows;
}

/**
 * @returns {{ approver: object|null, passedOver: Array, hasManager: boolean, note: string|null }}
 *   approver null + hasManager → every manager within 3 levels is unavailable (skip the step);
 *   approver null + !hasManager → requester has no Line Manager at all.
 */
async function resolveLineManager(requesterId) {
  const chain = await managerChain(requesterId);
  const { approver, passedOver } = availability.pickApprover(chain, requesterId);
  let note = null;
  if (passedOver.length && approver) {
    note = `Line Manager approval forwarded to ${approver.name}: ${availability.describePassedOver(passedOver)}.`;
  } else if (passedOver.length) {
    note = `Line Manager step skipped — no available manager within ${availability.MAX_LEVELS} levels: ${availability.describePassedOver(passedOver)}.`;
  }
  return { approver, passedOver, hasManager: chain.length > 0, note };
}

function portalBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

async function notifyNewApprover(approver, kind, row, note) {
  if (!approver?.email) return;
  const isTicket = kind === 'ticket';
  await notifyUser({
    targetEmail: approver.email,
    name: approver.name,
    subject: `${isTicket ? 'Ticket' : 'Request'} ${row.public_id} forwarded to you for Line Manager review`,
    title: 'Line Manager review forwarded to you',
    text: `${note} ${isTicket ? `Ticket "${row.subject}"` : `Asset request for "${row.item}"`} by ${row.requester_name} now needs your Line Manager review.`,
    type: 'warning',
    ctaLabel: isTicket ? 'Review ticket' : 'Review request',
    ctaUrl: `${portalBase()}/${isTicket ? 'tickets' : 'approvals'}`,
    event: isTicket ? 'ticket.pending_line_manager' : 'requisition.pending_approver',
  });
}

async function notifyRequesterOfForward(kind, row, note) {
  if (!row.requester_email) return;
  await notifyUser({
    targetEmail: row.requester_email,
    name: row.requester_name,
    subject: `${kind === 'ticket' ? 'Ticket' : 'Request'} ${row.public_id}: Line Manager review forwarded`,
    title: 'Line Manager review forwarded',
    text: note,
    type: 'info',
    ctaLabel: 'View',
    ctaUrl: `${portalBase()}/${kind === 'ticket' ? 'tickets' : 'requisitions'}`,
    event: kind === 'ticket' ? 'ticket.status_changed' : 'requisition.status_changed',
  });
}

async function forwardTicket(ticket, leaver) {
  const route = await resolveLineManager(ticket.requester_id);
  const reason = `${leaver.name} is on leave.`;

  if (route.approver) {
    const note = `${reason} ${route.note || `Forwarded to ${route.approver.name}.`}`;
    const moved = await db.query(
      `UPDATE tickets SET line_manager_id = $3, updated_at = NOW()
       WHERE id = $1 AND status = $2 AND line_manager_id = $4 AND deleted_at IS NULL RETURNING *`,
      [ticket.id, TICKET_STATUS.PENDING_LINE_MANAGER, route.approver.id, leaver.id]
    );
    if (!moved.rows[0]) return null;
    await db.query(
      `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by_id, changed_by_name, note)
       VALUES ($1, $2, $2, NULL, 'System', $3)`,
      [ticket.id, TICKET_STATUS.PENDING_LINE_MANAGER, note]
    );
    await db.query(
      `INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, 'System', 'System', $2)`,
      [ticket.id, note]
    );
    await notifyNewApprover(route.approver, 'ticket', ticket, note);
    await notifyRequesterOfForward('ticket', ticket, `Your ticket ${ticket.public_id}: ${note}`);
    return { id: ticket.public_id, to: route.approver.name };
  }

  const note = `${reason} ${route.note || 'No other Line Manager available.'} Sent to IT triage; Admin/IT will set the priority.`;
  const moved = await db.query(
    `UPDATE tickets SET status = $3, line_manager_id = NULL, updated_at = NOW()
     WHERE id = $1 AND status = $2 AND line_manager_id = $4 AND deleted_at IS NULL RETURNING *`,
    [ticket.id, TICKET_STATUS.PENDING_LINE_MANAGER, TICKET_STATUS.PENDING_TRIAGE, leaver.id]
  );
  if (!moved.rows[0]) return null;
  await db.query(
    `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by_id, changed_by_name, note)
     VALUES ($1, $2, $3, NULL, 'System', $4)`,
    [ticket.id, TICKET_STATUS.PENDING_LINE_MANAGER, TICKET_STATUS.PENDING_TRIAGE, note]
  );
  await db.query(
    `INSERT INTO ticket_replies (ticket_id, author, role_label, text) VALUES ($1, 'System', 'System', $2)`,
    [ticket.id, note]
  );
  // Lazy require: ticketsController depends on this module.
  const { notifyItTriage } = require('../controllers/ticketsController');
  await notifyItTriage(moved.rows[0], [ticket.requester_email]);
  await notifyRequesterOfForward('ticket', ticket, `Your ticket ${ticket.public_id}: ${note}`);
  return { id: ticket.public_id, to: 'IT triage' };
}

async function forwardRequest(row, leaver) {
  const workflow = require('./requisitionWorkflow');
  const route = await resolveLineManager(row.requester_id);
  const reason = `${leaver.name} is on leave.`;
  const today = new Date().toISOString().split('T')[0];

  if (route.approver) {
    const note = `${reason} ${route.note || `Forwarded to ${route.approver.name}.`}`;
    const moved = await db.query(
      `UPDATE requisitions SET
         line_manager_id = $3, approver_id = $3, approver_name = $4,
         decision_history = COALESCE(decision_history, '') || $5, updated_at = NOW()
       WHERE id = $1 AND status = $2 AND line_manager_id = $6 RETURNING id`,
      [row.id, row.status, route.approver.id, route.approver.name, `${today}: ${note}\n`, leaver.id]
    );
    if (!moved.rows[0]) return null;
    await workflow.addReply(row.id, 'System', 'System', note);
    await notifyNewApprover(route.approver, 'request', row, note);
    await notifyRequesterOfForward('request', row, `Your request ${row.public_id}: ${note}`);
    return { id: row.public_id, to: route.approver.name };
  }

  const note = `${reason} ${route.note || 'No other Line Manager available.'} Sent to IT for the inventory check.`;
  const moved = await db.query(
    `UPDATE requisitions SET
       status = $3, current_stage = $3, line_manager_id = NULL, approver_id = NULL, approver_name = NULL,
       decision_history = COALESCE(decision_history, '') || $4, updated_at = NOW()
     WHERE id = $1 AND status = $2 AND line_manager_id = $5 RETURNING id`,
    [row.id, row.status, REQ_STATUS.PENDING_IT_INVENTORY, `${today}: ${note}\n`, leaver.id]
  );
  if (!moved.rows[0]) return null;
  await workflow.addReply(row.id, 'System', 'System', note);
  const fresh = await workflow.findFresh(row.id);
  await workflow.notifyInventoryCheck(fresh, await workflow.loadContext());
  await notifyRequesterOfForward('request', row, `Your request ${row.public_id}: ${note}`);
  return { id: row.public_id, to: 'IT inventory check' };
}

/**
 * `leaver` just switched to On Leave: forward every ticket / asset request waiting for their
 * Line Manager review. Returns the moved items.
 */
async function forwardWaitingFor(leaver) {
  const tickets = await db.query(
    `SELECT * FROM tickets WHERE status = $1 AND line_manager_id = $2 AND deleted_at IS NULL ORDER BY id`,
    [TICKET_STATUS.PENDING_LINE_MANAGER, leaver.id]
  );
  const requests = await db.query(
    `SELECT * FROM requisitions WHERE status = ANY($1::text[]) AND line_manager_id = $2 ORDER BY id`,
    [[REQ_STATUS.PENDING_LINE_MANAGER, 'Pending Manager Approval'], leaver.id]
  );

  const moved = { tickets: [], requests: [] };
  for (const t of tickets.rows) {
    const r = await forwardTicket(t, leaver);
    if (r) moved.tickets.push(r);
  }
  for (const q of requests.rows) {
    const r = await forwardRequest(q, leaver);
    if (r) moved.requests.push(r);
  }

  if (moved.tickets.length || moved.requests.length) {
    const list = [...moved.tickets, ...moved.requests].map((m) => `${m.id} → ${m.to}`).join('; ');
    await addAuditLog({
      user: { name: 'System', email: 'system@integriti.io', role: { name: 'System' } },
      action: 'Line Manager Approvals Forwarded',
      details: `${leaver.name} went on leave; forwarded: ${list}`,
      targetId: String(leaver.id),
    });
  }
  return moved;
}

module.exports = { managerChain, resolveLineManager, forwardWaitingFor };
