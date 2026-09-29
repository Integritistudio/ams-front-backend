const db = require('../config/database');

/** Workflow designation flags — multiple roles/users may share them. */
const ROLE_FLAGS = [
  'is_it_admin',
  'is_hr_manager',
  'is_finance_manager',
  'is_gm',
  'is_executive',
];

const Role = {
  async findAll() {
    const result = await db.query(
      `SELECT r.*,
        (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS user_count
       FROM roles r
       ORDER BY r.name ASC`
    );
    return result.rows.map((r) => ({ ...r, is_approver: false }));
  },

  async findById(id) {
    const result = await db.query(`SELECT * FROM roles WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, is_approver: false };
  },

  async create(payload) {
    const {
      name,
      description,
      is_active = true,
      is_it_admin = false,
      is_executive = false,
      is_hr_manager = false,
      is_finance_manager = false,
      is_gm = false,
      can_export = false,
    } = payload;
    const result = await db.query(
      `INSERT INTO roles (
         name, description, is_active,
         is_it_admin, is_approver, is_executive,
         is_hr_manager, is_finance_manager, is_gm,
         can_export
       ) VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,$8,$9) RETURNING *`,
      [
        name,
        description || null,
        is_active,
        Boolean(is_it_admin),
        Boolean(is_executive),
        Boolean(is_hr_manager),
        Boolean(is_finance_manager),
        Boolean(is_gm),
        Boolean(can_export),
      ]
    );
    return { ...result.rows[0], is_approver: false };
  },

  async update(id, payload) {
    const {
      name,
      description,
      is_active,
      is_it_admin,
      is_executive,
      is_hr_manager,
      is_finance_manager,
      is_gm,
      can_export,
    } = payload;
    const result = await db.query(
      `UPDATE roles SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         is_active = COALESCE($4, is_active),
         is_it_admin = $5,
         is_approver = FALSE,
         is_executive = $6,
         is_hr_manager = $7,
         is_finance_manager = $8,
         is_gm = $9,
         can_export = COALESCE($10, can_export),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        id,
        name,
        description,
        is_active,
        Boolean(is_it_admin),
        Boolean(is_executive),
        Boolean(is_hr_manager),
        Boolean(is_finance_manager),
        Boolean(is_gm),
        can_export === undefined ? null : Boolean(can_export),
      ]
    );
    const row = result.rows[0];
    return row ? { ...row, is_approver: false } : null;
  },

  async remove(id) {
    await db.query(`DELETE FROM roles WHERE id = $1`, [id]);
  },

  async findRoleWithFlag(flagColumn, excludeId = null) {
    if (!ROLE_FLAGS.includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    const result = await db.query(
      `SELECT * FROM roles WHERE ${flagColumn} = TRUE
       ${excludeId ? 'AND id <> $1' : ''}
       ORDER BY id ASC LIMIT 1`,
      excludeId ? [excludeId] : []
    );
    return result.rows[0] || null;
  },

  /** First active user with this flag (labels / fallback). Prefer findUsersWithFlag for notifications. */
  async findDesignatedUser(flagColumn) {
    if (!ROLE_FLAGS.includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.department, u.designation, u.status,
              r.id AS role_id, r.name AS role_name,
              COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
              FALSE AS is_approver,
              COALESCE(r.is_executive, FALSE) AS is_executive,
              COALESCE(r.is_hr_manager, FALSE) AS is_hr_manager,
              COALESCE(r.is_finance_manager, FALSE) AS is_finance_manager,
              COALESCE(r.is_gm, FALSE) AS is_gm
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.${flagColumn} = TRUE AND u.status = 'Active'
       ORDER BY u.id ASC
       LIMIT 1`
    );
    return result.rows[0] || null;
  },

  async findUsersWithFlag(flagColumn) {
    if (!ROLE_FLAGS.includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.department, u.designation, u.status,
              r.id AS role_id, r.name AS role_name,
              COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
              FALSE AS is_approver,
              COALESCE(r.is_executive, FALSE) AS is_executive,
              COALESCE(r.is_hr_manager, FALSE) AS is_hr_manager,
              COALESCE(r.is_finance_manager, FALSE) AS is_finance_manager,
              COALESCE(r.is_gm, FALSE) AS is_gm
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.${flagColumn} = TRUE AND u.status = 'Active'
       ORDER BY u.name ASC`
    );
    return result.rows;
  },

  async getPermissions(roleId) {
    const result = await db.query(
      `SELECT m.id, m.slug, m.name, m.icon, m.sort_order,
              COALESCE(rp.can_view_all, FALSE) AS can_view_all,
              (rp.id IS NOT NULL) AS allowed
       FROM modules m
       LEFT JOIN role_permissions rp ON rp.module_id = m.id AND rp.role_id = $1
       WHERE m.is_active = TRUE
       ORDER BY m.sort_order ASC, m.name ASC`,
      [roleId]
    );
    return result.rows;
  },

  async setPermissions(roleId, permissions) {
    await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    for (const p of permissions || []) {
      if (!p.allowed && !p.module_id) continue;
      const moduleId = p.module_id || p.id;
      if (!moduleId || p.allowed === false) continue;
      await db.query(
        `INSERT INTO role_permissions (role_id, module_id, can_view_all)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_id, module_id) DO UPDATE SET can_view_all = EXCLUDED.can_view_all`,
        [roleId, moduleId, Boolean(p.can_view_all)]
      );
    }
  },

  async countUsers(roleId, excludeUserId = null) {
    const result = await db.query(
      `SELECT COUNT(*)::int AS c FROM users
       WHERE role_id = $1 AND status = 'Active'
       ${excludeUserId ? 'AND id <> $2' : ''}`,
      excludeUserId ? [roleId, excludeUserId] : [roleId]
    );
    return result.rows[0]?.c || 0;
  },

  async getUsers(roleId) {
    const result = await db.query(
      `SELECT id, name, email, status FROM users WHERE role_id = $1 ORDER BY name ASC`,
      [roleId]
    );
    return result.rows;
  },
};

module.exports = Role;
