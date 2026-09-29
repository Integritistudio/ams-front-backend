const db = require('../config/database');

const User = {
  async findAll({ search, roleId, department, status, includeDeleted = true } = {}) {
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
    } else if (!includeDeleted) {
      clauses.push(`u.status <> 'Deleted'`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.department, u.designation, u.manager, u.manager_id, u.phone,
              u.avatar_url, u.status, u.role_id, u.must_setup_password, u.created_at,
              u.deleted_at,
              COALESCE(u.is_super_admin, FALSE) AS is_super_admin,
              r.name AS role_name,
              COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
              FALSE AS is_approver,
              COALESCE(r.is_executive, FALSE) AS is_executive,
              COALESCE(r.is_hr_manager, FALSE) AS is_hr_manager,
              COALESCE(r.is_finance_manager, FALSE) AS is_finance_manager,
              COALESCE(r.is_gm, FALSE) AS is_gm,
              m.name AS manager_user_name, m.email AS manager_user_email
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN users m ON m.id = u.manager_id
       ${where}
       ORDER BY CASE WHEN u.status = 'Deleted' THEN 1 ELSE 0 END, u.name ASC`,
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

  async findByEmail(email, { includeDeleted = true } = {}) {
    const result = await db.query(
      `SELECT u.*, r.name AS role_name FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE LOWER(u.email) = LOWER($1)
         ${includeDeleted ? '' : "AND u.status <> 'Deleted'"}`,
      [email]
    );
    return result.rows[0] || null;
  },

  async create(data) {
    let managerName = data.manager || null;
    if (data.manager_id) {
      const mgr = await db.query(`SELECT name FROM users WHERE id = $1`, [data.manager_id]);
      if (mgr.rows[0]) managerName = mgr.rows[0].name;
    }
    const result = await db.query(
      `INSERT INTO users (email, name, password_hash, department, designation, manager, manager_id, phone, status, role_id, must_setup_password, avatar_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, email, name, department, designation, manager, manager_id, phone, status, role_id, must_setup_password, avatar_url, deleted_at`,
      [
        data.email.toLowerCase(),
        data.name,
        data.password_hash || null,
        data.department || null,
        data.designation || null,
        managerName,
        data.manager_id || null,
        data.phone || null,
        data.status || 'Active',
        data.role_id,
        data.must_setup_password ?? false,
        data.avatar_url || null,
      ]
    );
    return result.rows[0];
  },

  async update(id, data) {
    let managerName = data.manager;
    if (data.manager_id !== undefined) {
      if (data.manager_id) {
        const mgr = await db.query(`SELECT name FROM users WHERE id = $1`, [data.manager_id]);
        managerName = mgr.rows[0]?.name || null;
      } else {
        managerName = null;
      }
    }
    const result = await db.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         email = COALESCE($3, email),
         department = COALESCE($4, department),
         designation = COALESCE($5, designation),
         manager = CASE WHEN $12::boolean THEN $6 ELSE COALESCE($6, manager) END,
         manager_id = CASE WHEN $13::boolean THEN $14 ELSE manager_id END,
         phone = COALESCE($7, phone),
         status = COALESCE($8, status),
         role_id = COALESCE($9, role_id),
         avatar_url = COALESCE($10, avatar_url),
         password_hash = COALESCE($11, password_hash),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, department, designation, manager, manager_id, phone, status, role_id, avatar_url, deleted_at`,
      [
        id,
        data.name,
        data.email ? data.email.toLowerCase() : null,
        data.department,
        data.designation,
        managerName !== undefined ? managerName : data.manager,
        data.phone,
        data.status,
        data.role_id,
        data.avatar_url,
        data.password_hash,
        data.manager_id !== undefined || data.manager !== undefined,
        data.manager_id !== undefined,
        data.manager_id !== undefined ? data.manager_id || null : null,
      ]
    );
    return result.rows[0];
  },

  async updateStatus(id, status) {
    const result = await db.query(
      `UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1
       RETURNING id, email, name, status, role_id, deleted_at`,
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

  /** Soft delete — keeps row + all FK links (tickets, requisitions, assets, etc.). */
  async softDelete(id) {
    const result = await db.query(
      `UPDATE users SET
         status = 'Deleted',
         deleted_at = NOW(),
         updated_at = NOW()
       WHERE id = $1 AND status <> 'Deleted'
       RETURNING id, email, name, status, role_id, deleted_at`,
      [id]
    );
    return result.rows[0] || null;
  },

  async restore(id) {
    const result = await db.query(
      `UPDATE users SET
         status = 'Active',
         deleted_at = NULL,
         updated_at = NOW()
       WHERE id = $1 AND status = 'Deleted'
       RETURNING id, email, name, status, role_id, deleted_at`,
      [id]
    );
    return result.rows[0] || null;
  },

  /** Counts of linked records that remain after soft delete. */
  async relatedSummary(id) {
    const uid = Number(id);
    const emailRes = await db.query(`SELECT email FROM users WHERE id = $1`, [uid]);
    const email = emailRes.rows[0]?.email || '';

    const [tickets, reqsAsRequester, reqsAsApprover, assets, uploads, logs] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS c FROM tickets
         WHERE requester_id = $1 OR LOWER(requester_email) = LOWER($2)`,
        [uid, email]
      ),
      db.query(
        `SELECT COUNT(*)::int AS c FROM requisitions
         WHERE requester_id = $1 OR LOWER(requester_email) = LOWER($2)`,
        [uid, email]
      ),
      db.query(`SELECT COUNT(*)::int AS c FROM requisitions WHERE approver_id = $1`, [uid]),
      db.query(
        `SELECT COUNT(*)::int AS c FROM user_assets
         WHERE user_id = $1 OR LOWER(user_email) = LOWER($2)`,
        [uid, email]
      ),
      db.query(`SELECT COUNT(*)::int AS c FROM file_attachments WHERE uploaded_by = $1`, [uid]),
      db.query(
        `SELECT COUNT(*)::int AS c FROM audit_logs WHERE LOWER(user_email) = LOWER($1)`,
        [email]
      ),
    ]);

    return {
      tickets: tickets.rows[0]?.c || 0,
      requisitions: reqsAsRequester.rows[0]?.c || 0,
      approvals_assigned: reqsAsApprover.rows[0]?.c || 0,
      assets: assets.rows[0]?.c || 0,
      audit_logs: logs.rows[0]?.c || 0,
      uploads: uploads.rows[0]?.c || 0,
    };
  },
};

module.exports = User;
