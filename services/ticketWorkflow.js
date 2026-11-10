/**
 * Pure rules for the Support Ticket workflow (no DB access, no side effects).
 * ticketsController.js applies these decisions and persists the result.
 *
 * Lifecycle (requirements: Support Ticket, Steps 1–5):
 *   Pending Line Manager ──(LM sets priority)──▶ Pending IT Triage ──(Admin/IT assigns)──▶ Assigned
 *   Assigned ⇄ In Progress ⇄ On Hold ──(assignee records resolution)──▶ Resolved ──(Admin/IT)──▶ Completed
 *   Pending Line Manager ──(LM rejects)──▶ Rejected
 * Requesters without a Line Manager go straight to Pending IT Triage; Admin/IT then sets the priority.
 */
const { TICKET_STATUS: S } = require('./workflowConstants');

const VALID_PRIORITIES = ['High', 'Medium', 'Low'];
const TICKET_SLA_HOURS = { High: 4, Medium: 24, Low: 48 };
const OTHER_CATEGORY = 'Other';

/** Statuses in which the ticket is still being worked (can be reassigned / edited by Admin/IT). */
const WORKING = [S.ASSIGNED, S.IN_PROGRESS, S.ON_HOLD];
const CLOSED = [S.COMPLETED, S.REJECTED];

/**
 * Assignee actions: who may run them and from which statuses.
 * `actor: 'assignee'` → only the IT resource the ticket is assigned to.
 * `actor: 'it_admin'` → any Admin/IT user.
 */
const ACTIONS = {
  assign: { actor: 'it_admin', from: [S.PENDING_TRIAGE, ...WORKING] },
  in_progress: { actor: 'assignee', from: [S.ASSIGNED], to: S.IN_PROGRESS },
  hold: { actor: 'assignee', from: [S.ASSIGNED, S.IN_PROGRESS], to: S.ON_HOLD },
  resume: { actor: 'assignee', from: [S.ON_HOLD], to: S.IN_PROGRESS },
  resolve: { actor: 'assignee', from: [S.ASSIGNED, S.IN_PROGRESS], to: S.RESOLVED },
  complete: { actor: 'it_admin', from: [S.RESOLVED], to: S.COMPLETED },
  edit: { actor: 'it_admin', from: [S.PENDING_TRIAGE, ...WORKING] },
};

function slaHours(priority) {
  return TICKET_SLA_HOURS[priority] || TICKET_SLA_HOURS.Medium;
}

function isPriority(value) {
  return VALID_PRIORITIES.includes(String(value || '').trim());
}

/** Requirements: category, summary and description are mandatory; attachment optional. */
function validateNewTicket(body = {}) {
  const errors = [];
  const text = (v) => String(v ?? '').trim();
  if (!text(body.category)) errors.push('category is required');
  if (text(body.category) === OTHER_CATEGORY && !text(body.other_category)) {
    errors.push('other_category is required when category is Other');
  }
  if (!text(body.subject)) errors.push('subject (summary) is required');
  if (!text(body.description)) errors.push('description is required');
  return errors;
}

/** First status of a new ticket: Line Manager review when one is configured, else straight to IT triage. */
function initialStatus(lineManagerId) {
  return lineManagerId ? S.PENDING_LINE_MANAGER : S.PENDING_TRIAGE;
}

/**
 * Can `user` run `action` on `ticket`?
 * @param {string} action key of ACTIONS
 * @param {{ id, is_it_admin }} user
 * @param {{ status, assigned_to_id }} ticket
 * @returns {{ ok: boolean, status?: number, message?: string, to?: string }}
 */
function checkAction(action, user, ticket) {
  const rule = ACTIONS[action];
  if (!rule) return { ok: false, status: 400, message: `Unknown ticket action "${action}"` };
  if (!ticket) return { ok: false, status: 404, message: 'Ticket not found' };

  const isItAdmin = Boolean(user?.is_it_admin);
  const isAssignee =
    ticket.assigned_to_id != null && user?.id != null && Number(ticket.assigned_to_id) === Number(user.id);

  if (rule.actor === 'it_admin' && !isItAdmin) {
    return { ok: false, status: 403, message: 'Only Admin/IT can perform this action.' };
  }
  if (rule.actor === 'assignee' && !isAssignee) {
    return {
      ok: false,
      status: 403,
      message: isItAdmin
        ? 'Only the assigned IT resource can update this ticket. Reassign it to yourself first.'
        : 'Only the assigned IT resource can update this ticket.',
    };
  }
  if (!rule.from.includes(ticket.status)) {
    return { ok: false, status: 409, message: `Cannot ${action.replace('_', ' ')} a ticket that is "${ticket.status}".` };
  }
  return { ok: true, to: rule.to };
}

/** Assignment: Pending IT Triage → Assigned; a reassignment keeps the working status. */
function assignTarget(ticket) {
  return ticket.status === S.PENDING_TRIAGE ? S.ASSIGNED : ticket.status;
}

module.exports = {
  VALID_PRIORITIES,
  TICKET_SLA_HOURS,
  OTHER_CATEGORY,
  WORKING,
  CLOSED,
  ACTIONS,
  slaHours,
  isPriority,
  validateNewTicket,
  initialStatus,
  checkAction,
  assignTarget,
};
