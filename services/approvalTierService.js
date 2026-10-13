const db = require('../config/database');
const { SELF_APPROVAL, SELF_APPROVAL_MODES, sortTiers } = require('./approvalRouting');

const TIER_SELECT = `
  SELECT t.*, r.name AS role_name,
         COALESCE(r.is_hr_manager, FALSE) AS role_is_hr_manager,
         COALESCE(r.is_gm, FALSE) AS role_is_gm,
         COALESCE(r.is_executive, FALSE) AS role_is_executive
  FROM approval_tiers t
  JOIN roles r ON r.id = t.role_id
`;

function validationError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function listTiers({ activeOnly = false } = {}) {
  const result = await db.query(TIER_SELECT);
  const active = sortTiers(result.rows);
  if (activeOnly) return active;
  return [...active, ...result.rows.filter((t) => t.is_active === false)];
}

async function getTier(id) {
  const result = await db.query(`${TIER_SELECT} WHERE t.id = $1`, [id]);
  return result.rows[0] || null;
}

function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw validationError('max_amount must be a positive number, or empty for unlimited');
  }
  return n;
}

/** Limits must be unique and only one tier may be unlimited, so routing order is unambiguous. */
async function assertUniqueLimit(maxAmount, excludeId = null) {
  const result = await db.query(
    `SELECT id FROM approval_tiers
     WHERE is_active = TRUE
       AND ${maxAmount === null ? 'max_amount IS NULL' : 'max_amount = $2'}
       AND ($1::int IS NULL OR id <> $1)`,
    maxAmount === null ? [excludeId] : [excludeId, maxAmount]
  );
  if (result.rows.length) {
    throw validationError(
      maxAmount === null
        ? 'Only one approval tier can be unlimited.'
        : 'Another approval tier already uses this limit.',
      409
    );
  }
}

async function createTier({ role_id, max_amount, self_approval, is_active }) {
  if (!role_id) throw validationError('role_id is required');
  const mode = self_approval || SELF_APPROVAL.ESCALATE;
  if (!SELF_APPROVAL_MODES.includes(mode)) throw validationError('Invalid self_approval mode');
  const amount = parseAmount(max_amount);
  if (is_active !== false) await assertUniqueLimit(amount);
  try {
    const result = await db.query(
      `INSERT INTO approval_tiers (role_id, max_amount, self_approval, is_active)
       VALUES ($1, $2, $3, COALESCE($4, TRUE)) RETURNING id`,
      [role_id, amount, mode, is_active]
    );
    return getTier(result.rows[0].id);
  } catch (err) {
    if (err.code === '23505') throw validationError('This role already has an approval tier.', 409);
    if (err.code === '23503') throw validationError('Role not found');
    throw err;
  }
}

async function updateTier(id, body) {
  const existing = await getTier(id);
  if (!existing) throw validationError('Approval tier not found', 404);

  const amount = Object.prototype.hasOwnProperty.call(body, 'max_amount')
    ? parseAmount(body.max_amount)
    : existing.max_amount === null
      ? null
      : Number(existing.max_amount);
  const mode = body.self_approval || existing.self_approval;
  if (!SELF_APPROVAL_MODES.includes(mode)) throw validationError('Invalid self_approval mode');
  const active = body.is_active === undefined ? existing.is_active : Boolean(body.is_active);
  const roleId = body.role_id || existing.role_id;

  if (active) await assertUniqueLimit(amount, existing.id);
  if (!active || Number(roleId) !== Number(existing.role_id)) await assertNoPending(existing.id);

  try {
    await db.query(
      `UPDATE approval_tiers SET
         role_id = $2, max_amount = $3, self_approval = $4, is_active = $5, updated_at = NOW()
       WHERE id = $1`,
      [existing.id, roleId, amount, mode, active]
    );
  } catch (err) {
    if (err.code === '23505') throw validationError('This role already has an approval tier.', 409);
    throw err;
  }
  return getTier(existing.id);
}

async function assertNoPending(tierId) {
  const { REQ_STATUS } = require('./workflowConstants');
  const result = await db.query(
    `SELECT COUNT(*)::int AS c FROM requisitions WHERE approval_tier_id = $1 AND status = $2`,
    [tierId, REQ_STATUS.PENDING_PRICE_APPROVAL]
  );
  const count = result.rows[0]?.c || 0;
  if (count) {
    throw validationError(
      `${count} request(s) are pending approval at this tier. Resolve them before removing or reassigning it.`,
      409
    );
  }
}

async function removeTier(id) {
  const existing = await getTier(id);
  if (!existing) throw validationError('Approval tier not found', 404);
  await assertNoPending(existing.id);
  await db.query(`DELETE FROM approval_tiers WHERE id = $1`, [existing.id]);
  return existing;
}

/**
 * One-time default tiers: HR ≤ 50,000 (self-approve), GM ≤ 10,000,000 (auto), Executive unlimited (auto).
 * Runs once roles exist; afterwards tiers are fully admin-managed (deleting all does not reseed).
 */
async function ensureDefaultTiers() {
  const settings = await db.query(
    `SELECT approval_tiers_seeded, hr_approval_limit FROM portal_settings WHERE id = 1`
  );
  const row = settings.rows[0];
  if (!row || row.approval_tiers_seeded) return { seeded: false };

  const roles = await db.query(
    `SELECT
       (SELECT MIN(id) FROM roles WHERE is_hr_manager = TRUE) AS hr,
       (SELECT MIN(id) FROM roles WHERE is_gm = TRUE) AS gm,
       (SELECT MIN(id) FROM roles WHERE is_executive = TRUE) AS exec`
  );
  const { hr, gm, exec } = roles.rows[0] || {};
  if (!hr && !gm && !exec) return { seeded: false };

  const defaults = [
    [hr, Number(row.hr_approval_limit ?? 50000) || 50000, SELF_APPROVAL.MANUAL],
    [gm, 10000000, SELF_APPROVAL.AUTO],
    [exec, null, SELF_APPROVAL.AUTO],
  ].filter(([roleId]) => roleId);

  for (const [roleId, maxAmount, mode] of defaults) {
    await db.query(
      `INSERT INTO approval_tiers (role_id, max_amount, self_approval)
       VALUES ($1, $2, $3) ON CONFLICT (role_id) DO NOTHING`,
      [roleId, maxAmount, mode]
    );
  }
  await db.query(`UPDATE portal_settings SET approval_tiers_seeded = TRUE WHERE id = 1`);
  return { seeded: true };
}

module.exports = {
  listTiers,
  getTier,
  createTier,
  updateTier,
  removeTier,
  ensureDefaultTiers,
};
