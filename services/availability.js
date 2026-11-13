/**
 * User availability (set by each user in My Account) and the pure Line Manager routing rule built on it.
 * No DB access here — see lineManagerRouting.js for the queries and side effects.
 *
 * Rules (agreed spec):
 *  - Statuses: Available (default), In a Meeting, On Break, On Leave, Custom (free text).
 *  - Optional end date: after that day the user counts as Available again.
 *  - Only "On Leave" affects approvals; every other status is informational.
 *  - Line Manager step of tickets and asset requests: use the first manager, walking up at most
 *    3 levels (Line Manager → their manager → one above), who is active, not on leave and not the
 *    requester. If none qualifies, the Line Manager step is skipped.
 */

const STATUS = {
  AVAILABLE: 'Available',
  MEETING: 'In a Meeting',
  BREAK: 'On Break',
  LEAVE: 'On Leave',
  CUSTOM: 'Custom',
};
const STATUSES = Object.values(STATUS);
const MAX_LEVELS = 3;
const CUSTOM_MAX = 120;

function dayKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/** Status in force today: a status whose end date has passed counts as Available. */
function effectiveStatus(user, now = new Date()) {
  const status = user?.availability_status || STATUS.AVAILABLE;
  const until = dayKey(user?.availability_until);
  if (until && dayKey(now) > until) return STATUS.AVAILABLE;
  return STATUSES.includes(status) ? status : STATUS.AVAILABLE;
}

function isOnLeave(user, now = new Date()) {
  return effectiveStatus(user, now) === STATUS.LEAVE;
}

/** Display label, e.g. "On Leave until 2026-11-20" or the custom text. */
function statusLabel(user, now = new Date()) {
  const status = effectiveStatus(user, now);
  const base = status === STATUS.CUSTOM ? String(user?.availability_custom || 'Custom') : status;
  const until = dayKey(user?.availability_until);
  return status !== STATUS.AVAILABLE && until ? `${base} until ${until}` : base;
}

/**
 * Validate a My Account status change.
 * @returns {{ ok: true, value } | { ok: false, message }}
 */
function validateStatusUpdate(body = {}, now = new Date()) {
  const status = String(body.status || '').trim();
  if (!STATUSES.includes(status)) {
    return { ok: false, message: `status must be one of: ${STATUSES.join(', ')}` };
  }
  let custom = null;
  if (status === STATUS.CUSTOM) {
    custom = String(body.custom_text ?? body.custom ?? '').trim();
    if (!custom) return { ok: false, message: 'Enter the custom status text.' };
    if (custom.length > CUSTOM_MAX) return { ok: false, message: `Custom status is limited to ${CUSTOM_MAX} characters.` };
  }
  let until = null;
  if (status !== STATUS.AVAILABLE && body.until) {
    until = dayKey(body.until);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until))) {
      return { ok: false, message: 'until must be a date (YYYY-MM-DD).' };
    }
    if (until < dayKey(now)) return { ok: false, message: 'The end date cannot be in the past.' };
  }
  return { ok: true, value: { status, custom, until } };
}

/**
 * Pick the Line Manager approver.
 * @param {Array<object>} chain managers above the requester, nearest first
 *   (each { id, name, status, availability_status, availability_until }); only the first
 *   MAX_LEVELS entries are considered.
 * @param {number} requesterId
 * @returns {{ approver: object|null, passedOver: Array<{ user, reason }> }}
 *   approver null → no available manager within 3 levels: skip the Line Manager step.
 */
function pickApprover(chain, requesterId, now = new Date()) {
  const passedOver = [];
  for (const manager of (chain || []).slice(0, MAX_LEVELS)) {
    if (!manager) break;
    let reason = null;
    if (Number(manager.id) === Number(requesterId)) reason = 'requester';
    else if (manager.status && manager.status !== 'Active') reason = 'inactive';
    else if (isOnLeave(manager, now)) reason = 'on leave';
    if (!reason) return { approver: manager, passedOver };
    passedOver.push({ user: manager, reason });
  }
  return { approver: null, passedOver };
}

/** "Ali (on leave), Sara (on leave)" — for history notes. */
function describePassedOver(passedOver) {
  return passedOver.map((p) => `${p.user.name} (${p.reason})`).join(', ');
}

module.exports = {
  STATUS,
  STATUSES,
  MAX_LEVELS,
  dayKeyOf: dayKey,
  effectiveStatus,
  isOnLeave,
  statusLabel,
  validateStatusUpdate,
  pickApprover,
  describePassedOver,
};
