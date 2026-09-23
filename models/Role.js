const db = require('../config/database');

const Role = {
  async findAll() {
    const result = await db.query(
      `SELECT r.*,
        (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS user_count
       FROM roles r
       ORDER BY r.name ASC`
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(`SELECT * FROM roles WHERE id = $1`, [id]);
    return result.rows[0] || null;
  },

  async create({
    name,
    description,
    is_active = true,
    is_it_admin = false,
    is_approver = false,
    is_executive = false,
  }) {
    const result = await db.query(
      `INSERT INTO roles (name, description, is_active, is_it_admin, is_approver, is_executive)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        name,
        description || null,
        is_active,
        Boolean(is_it_admin),
        Boolean(is_approver),
        Boolean(is_executive),
      ]
    );
    return result.rows[0];
  },

  async update(id, { name, description, is_active, is_it_admin, is_approver, is_executive }) {
    const result = await db.query(
      `UPDATE roles SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         is_active = COALESCE($4, is_active),
         is_it_admin = $5,
         is_approver = $6,
         is_executive = $7,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        id,
        name,
        description,
        is_active,
        Boolean(is_it_admin),
        Boolean(is_approver),
        Boolean(is_executive),
      ]
    );
    return result.rows[0];
  },

  async remove(id) {
    await db.query(`DELETE FROM roles WHERE id = $1`, [id]);
  },

  /** Clear a special flag from every role except excludeId */
  async clearFlagExcept(flagColumn, excludeId) {
    if (!['is_it_admin', 'is_approver'].includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    await db.query(
      `UPDATE roles SET ${flagColumn} = FALSE, updated_at = NOW()
       WHERE id <> $1 AND ${flagColumn} = TRUE`,
      [excludeId]
    );
  },

  /** Find another role that already has this flag set */
  async findRoleWithFlag(flagColumn, excludeId = null) {
    if (!['is_it_admin', 'is_approver'].includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    const result = excludeId
      ? await db.query(
          `SELECT id, name FROM roles WHERE ${flagColumn} = TRUE AND id <> $1 LIMIT 1`,
          [excludeId]
        )
      : await db.query(
          `SELECT id, name FROM roles WHERE ${flagColumn} = TRUE LIMIT 1`
        );
    return result.rows[0] || null;
  },

  async countUsers(roleId, excludeUserId = null) {
    const result = excludeUserId
      ? await db.query(
          `SELECT COUNT(*)::int AS c FROM users WHERE role_id = $1 AND id <> $2`,
          [roleId, excludeUserId]
        )
      : await db.query(`SELECT COUNT(*)::int AS c FROM users WHERE role_id = $1`, [roleId]);
    return result.rows[0]?.c || 0;
  },

  /**
   * Active user holding a designated role flag (single).
   * @param {'is_it_admin'|'is_approver'|'is_executive'} flagColumn
   */
  async findDesignatedUser(flagColumn) {
    if (!['is_it_admin', 'is_approver', 'is_executive'].includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.department, u.designation, u.status,
              r.id AS role_id, r.name AS role_name,
              COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
              COALESCE(r.is_approver, FALSE) AS is_approver,
              COALESCE(r.is_executive, FALSE) AS is_executive
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.${flagColumn} = TRUE AND u.status = 'Active'
       ORDER BY u.id ASC
       LIMIT 1`
    );
    return result.rows[0] || null;
  },

  /**
   * All active users with a role flag (Executive can be many).
   * @param {'is_it_admin'|'is_approver'|'is_executive'} flagColumn
   */
  async findUsersWithFlag(flagColumn) {
    if (!['is_it_admin', 'is_approver', 'is_executive'].includes(flagColumn)) {
      throw new Error('Invalid flag column');
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.department, u.designation, u.status,
              r.id AS role_id, r.name AS role_name,
              COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
              COALESCE(r.is_approver, FALSE) AS is_approver,
              COALESCE(r.is_executive, FALSE) AS is_executive
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.${flagColumn} = TRUE AND u.status = 'Active'
       ORDER BY u.name ASC`
    );
    return result.rows;
  },

  async getPermissions(roleId) {
    const result = await db.query(
      `SELECT m.id AS module_id, m.slug, m.name, m.icon,
              CASE WHEN rp.id IS NULL THEN FALSE ELSE TRUE END AS allowed,
              COALESCE(rp.can_view_all, FALSE) AS can_view_all
       FROM modules m
       LEFT JOIN role_permissions rp ON rp.module_id = m.id AND rp.role_id = $1
       WHERE m.is_active = TRUE
       ORDER BY m.sort_order, m.name`,
      [roleId]
    );
    return result.rows;
  },

  async setPermissions(roleId, permissions) {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      for (const p of permissions) {
        if (!p.allowed) continue;
        await client.query(
          `INSERT INTO role_permissions (role_id, module_id, can_view_all)
           VALUES ($1, $2, $3)`,
          [roleId, p.module_id, Boolean(p.can_view_all)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getUsers(roleId) {
    const result = await db.query(
      `SELECT id, email, name, department, designation, status
       FROM users WHERE role_id = $1 ORDER BY name`,
      [roleId]
    );
    return result.rows;
  },
};

module.exports = Role;
