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

  async create({ name, description, is_active = true }) {
    const result = await db.query(
      `INSERT INTO roles (name, description, is_active) VALUES ($1, $2, $3) RETURNING *`,
      [name, description || null, is_active]
    );
    return result.rows[0];
  },

  async update(id, { name, description, is_active }) {
    const result = await db.query(
      `UPDATE roles SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         is_active = COALESCE($4, is_active),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, name, description, is_active]
    );
    return result.rows[0];
  },

  async remove(id) {
    await db.query(`DELETE FROM roles WHERE id = $1`, [id]);
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
