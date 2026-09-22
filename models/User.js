const db = require('../config/database');

const User = {
  async findAll({ search, roleId, department, status } = {}) {
    const clauses = [];
    const params = [];
    let i = 1;

    if (search) {
      clauses.push(`(u.name ILIKE $${i} OR u.email ILIKE $${i})`);
      params.push(`%${search}%`);
      i += 1;
    }
    if (roleId && roleId !== 'All') {
      clauses.push(`u.role_id = $${i}`);
      params.push(roleId);
      i += 1;
    }
    if (department && department !== 'All') {
      clauses.push(`u.department = $${i}`);
      params.push(department);
      i += 1;
    }
    if (status && status !== 'All') {
      clauses.push(`u.status = $${i}`);
      params.push(status);
      i += 1;
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.department, u.designation, u.manager, u.phone,
              u.avatar_url, u.status, u.role_id, u.must_setup_password, u.created_at,
              r.name AS role_name,
              COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
              COALESCE(r.is_approver, FALSE) AS is_approver,
              COALESCE(r.is_executive, FALSE) AS is_executive
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       ${where}
       ORDER BY u.name ASC`,
      params
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT u.*, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByEmail(email) {
    const result = await db.query(
      `SELECT u.*, r.name AS role_name FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE LOWER(u.email) = LOWER($1)`,
      [email]
    );
    return result.rows[0] || null;
  },

  async create(data) {
    const result = await db.query(
      `INSERT INTO users (email, name, password_hash, department, designation, manager, phone, status, role_id, must_setup_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, email, name, department, designation, manager, phone, status, role_id, must_setup_password`,
      [
        data.email.toLowerCase(),
        data.name,
        data.password_hash || null,
        data.department || null,
        data.designation || null,
        data.manager || null,
        data.phone || null,
        data.status || 'Active',
        data.role_id,
        data.must_setup_password ?? false,
      ]
    );
    return result.rows[0];
  },

  async update(id, data) {
    const result = await db.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         email = COALESCE($3, email),
         department = COALESCE($4, department),
         designation = COALESCE($5, designation),
         manager = COALESCE($6, manager),
         phone = COALESCE($7, phone),
         status = COALESCE($8, status),
         role_id = COALESCE($9, role_id),
         avatar_url = COALESCE($10, avatar_url),
         password_hash = COALESCE($11, password_hash),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, department, designation, manager, phone, status, role_id, avatar_url`,
      [
        id,
        data.name,
        data.email ? data.email.toLowerCase() : null,
        data.department,
        data.designation,
        data.manager,
        data.phone,
        data.status,
        data.role_id,
        data.avatar_url,
        data.password_hash,
      ]
    );
    return result.rows[0];
  },

  async updateStatus(id, status) {
    const result = await db.query(
      `UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1
       RETURNING id, email, name, status, role_id`,
      [id, status]
    );
    return result.rows[0];
  },

  async updateRole(id, roleId) {
    const result = await db.query(
      `UPDATE users SET role_id = $2, updated_at = NOW() WHERE id = $1
       RETURNING id, email, name, status, role_id`,
      [id, roleId]
    );
    return result.rows[0];
  },

  async remove(id) {
    await db.query(`DELETE FROM users WHERE id = $1`, [id]);
  },
};

module.exports = User;
