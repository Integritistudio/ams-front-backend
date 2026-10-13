/**
 * Pure routing rules for the asset request workflow (no DB access, no side effects).
 * requisitionWorkflow.js applies these decisions and persists the result.
 *
 * Responsibility types:
 *  - Approval   (Line Manager, HR in-stock, price tiers) — requester never approves own request,
 *                except tiers configured with self_approval = 'manual' | 'auto'.
 *  - Verification (IT inventory check + initial price) — IT Admin role, never skipped; another
 *                IT Admin handles it when the requester is an IT Admin (unless they are the only one).
 *  - Processing (Finance quotation + payment, IT delivery) — always kept, even for own request.
 */
const { REQ_STATUS } = require('./workflowConstants');

const SELF_APPROVAL = {
  ESCALATE: 'escalate', // requester's own tier is skipped → next tier above
  MANUAL: 'manual', // requester may approve own request within the tier limit
  AUTO: 'auto', // auto-approved within the tier limit
};

const SELF_APPROVAL_MODES = Object.values(SELF_APPROVAL);

function num(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

/** Active tiers ordered by limit ascending; the unlimited tier (max_amount null) is last. */
function sortTiers(tiers) {
  return (tiers || [])
    .filter((t) => t && t.is_active !== false)
    .slice()
    .sort((a, b) => {
      const am = num(a.max_amount);
      const bm = num(b.max_amount);
      if (am === null && bm === null) return Number(a.id) - Number(b.id);
      if (am === null) return 1;
      if (bm === null) return -1;
      return am - bm;
    });
}

function coversAmount(tier, amount) {
  const max = num(tier.max_amount);
  return max === null || Number(amount) <= max;
}

/**
 * Decide who approves a procurement amount.
 * @param {Array} tiers approval_tiers rows
 * @param {number} amount
 * @param {{ role_id?: number }} requester
 * @returns {{ kind: 'auto', tier } | { kind: 'tier', tier, requesterMayAct: boolean } | { kind: 'unrouted' }}
 *   'unrouted' = no configured tier can approve this amount (Super Admin must act / fix config).
 */
function resolvePriceApproval(tiers, amount, requester = {}) {
  const ordered = sortTiers(tiers);
  const roleId = num(requester.role_id);
  const ownIdx = roleId === null ? -1 : ordered.findIndex((t) => Number(t.role_id) === roleId);

  // Requester holds an approval tier that covers this amount → apply that tier's self-approval rule.
  if (ownIdx >= 0 && coversAmount(ordered[ownIdx], amount)) {
    const own = ordered[ownIdx];
    const mode = own.self_approval || SELF_APPROVAL.ESCALATE;
    if (mode === SELF_APPROVAL.AUTO) return { kind: 'auto', tier: own };
    if (mode === SELF_APPROVAL.MANUAL) return { kind: 'tier', tier: own, requesterMayAct: true };
    const next = ordered.slice(ownIdx + 1).find((t) => Number(t.role_id) !== roleId);
    return next ? { kind: 'tier', tier: next, requesterMayAct: false } : { kind: 'unrouted' };
  }

  // Amount goes directly to the lowest tier whose limit covers it.
  const base = ordered.find((t) => coversAmount(t, amount) && Number(t.role_id) !== roleId);
  return base ? { kind: 'tier', tier: base, requesterMayAct: false } : { kind: 'unrouted' };
}

/** GM and Executive requests skip Line Manager approval. */
function skipsLineManager(requesterRole = {}) {
  return Boolean(requesterRole.is_gm || requesterRole.is_executive);
}

/** Requester is an IT Admin and no other active IT Admin exists. */
function isLoneItAdmin(requester = {}, itAdminIds = []) {
  if (!requester.is_it_admin) return false;
  return !itAdminIds.some((id) => Number(id) !== Number(requester.id));
}

/**
 * In-stock path: HR approval is skipped when the requester is HR (cannot self-approve),
 * GM / Executive (senior authority), or the only IT Admin (Line Manager approval suffices).
 */
function skipsInStockHr(requesterRole = {}, { loneItAdmin = false } = {}) {
  return Boolean(
    requesterRole.is_hr_manager || requesterRole.is_gm || requesterRole.is_executive || loneItAdmin
  );
}

/** IT Admin may verify/price a request unless it is their own (and another IT Admin exists). */
function canHandleItVerification(user, requester, itAdminIds) {
  if (!user?.role?.is_it_admin) return false;
  if (Number(user.id) !== Number(requester.id)) return true;
  return isLoneItAdmin(requester, itAdminIds);
}

const NONE = { stage: null, action: null, canAct: false, canReject: false };

function access(stage, action, canAct, canReject, message) {
  return { stage, action, canAct, canReject: canAct && canReject, message: canAct ? null : message };
}

/**
 * Who may act on a request's current stage.
 * @param {{ id, role, is_super_admin }} user acting user (role = role flags incl. id)
 * @param {object} row requisition row incl. requester_role_id / requester_is_it_admin
 * @param {{ tiers: Array, itAdminIds: number[] }} ctx
 * @returns {{ stage, action, canAct, canReject, message }}
 *   action: 'approve' | 'inventory_check' | 'pricing' | 'finance_process' | null
 */
function getStageAccess(user, row, ctx = {}) {
  if (!user || !row) return NONE;
  const role = user.role || {};
  const userId = Number(user.id);
  const isRequester = row.requester_id != null && Number(row.requester_id) === userId;
  const requester = {
    id: row.requester_id,
    role_id: row.requester_role_id,
    is_it_admin: Boolean(row.requester_is_it_admin),
  };

  switch (row.status) {
    case REQ_STATUS.PENDING_LINE_MANAGER:
    case 'Pending Manager Approval': {
      const ok = row.line_manager_id != null && Number(row.line_manager_id) === userId && !isRequester;
      return access('line_manager', 'approve', ok, true, 'Only the Line Manager can act on this request.');
    }

    case REQ_STATUS.PENDING_IT_INVENTORY: {
      const ok = canHandleItVerification(user, requester, ctx.itAdminIds || []);
      return access(
        'it_inventory',
        'inventory_check',
        ok,
        false,
        isRequester && role.is_it_admin
          ? 'Another IT Admin must verify inventory for your own request.'
          : 'Only IT Admin can confirm inventory.'
      );
    }

    case REQ_STATUS.PENDING_IT_PRICING: {
      const ok = canHandleItVerification(user, requester, ctx.itAdminIds || []);
      return access(
        'it_pricing',
        'pricing',
        ok,
        false,
        isRequester && role.is_it_admin
          ? 'Another IT Admin must submit pricing for your own request.'
          : 'Only IT Admin can submit pricing.'
      );
    }

    case REQ_STATUS.PENDING_HR: {
      const ok = Boolean(role.is_hr_manager) && !isRequester;
      return access('hr', 'approve', ok, true, 'Only HR Manager can act at this stage.');
    }

    case REQ_STATUS.PENDING_PRICE_APPROVAL: {
      const tier = (ctx.tiers || []).find((t) => Number(t.id) === Number(row.approval_tier_id));
      if (!tier) {
        const ok = Boolean(user.is_super_admin);
        return access(
          'price_approval',
          'approve',
          ok,
          true,
          'No approval tier covers this amount. Super Admin must act or update approval tiers.'
        );
      }
      const holdsTier = role.id != null && Number(role.id) === Number(tier.role_id);
      const selfAllowed = tier.self_approval === SELF_APPROVAL.MANUAL;
      const ok = holdsTier && (!isRequester || selfAllowed);
      return access(
        'price_approval',
        'approve',
        ok,
        true,
        holdsTier ? 'You cannot approve your own request.' : 'Only the assigned approver role can act at this stage.'
      );
    }

    case REQ_STATUS.PENDING_FINANCE_PROCESSING: {
      // Processing responsibility — Finance handles it even when Finance is the requester.
      const ok = Boolean(role.is_finance_manager);
      return access('finance_processing', 'finance_process', ok, true, 'Only Finance Manager can process payment.');
    }

    // ---- Legacy stages (requests created before the requester-based workflow) ----
    case REQ_STATUS.PENDING_FINANCE: {
      const ok = Boolean(role.is_finance_manager) && !isRequester;
      return access('legacy_finance', 'approve', ok, true, 'Only Finance Manager can act at this stage.');
    }
    case REQ_STATUS.PENDING_GM: {
      if (role.is_gm && !isRequester) return access('legacy_gm', 'approve', true, true);
      if (role.is_executive && !isRequester) return access('legacy_executive', 'approve', true, true);
      return access('legacy_gm', 'approve', false, true, 'Only GM or Executive can act at this stage.');
    }
    case REQ_STATUS.PENDING_EXECUTIVE: {
      const ok = Boolean(role.is_executive) && !isRequester;
      return access('legacy_executive', 'approve', ok, true, 'Only Executive can act at this stage.');
    }

    default:
      return { ...NONE, message: 'Request is not awaiting an approval decision.' };
  }
}

module.exports = {
  SELF_APPROVAL,
  SELF_APPROVAL_MODES,
  sortTiers,
  coversAmount,
  resolvePriceApproval,
  skipsLineManager,
  skipsInStockHr,
  isLoneItAdmin,
  canHandleItVerification,
  getStageAccess,
};
