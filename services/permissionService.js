const db = require('../config/database');

async function getUserAuthorization(userId) {
  const userResult = await db.query(
    `SELECT u.id, u.email, u.name, u.department, u.designation, u.manager, u.phone,
            u.avatar_url, u.status, u.role_id, u.must_setup_password,
            r.id AS role_table_id, r.name AS role_name, r.description AS role_description
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

  const user = userResult.rows[0];
  if (!user || user.status !== 'Active') return null;

  const permResult = await db.query(
    `SELECT m.slug, m.name, rp.can_view_all
     FROM role_permissions rp
     JOIN modules m ON m.id = rp.module_id
     WHERE rp.role_id = $1 AND m.is_active = TRUE`,
    [user.role_id]
  );

  const permissionMeta = permResult.rows;
  const permissions = permissionMeta.map((p) => p.slug);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      department: user.department,
      designation: user.designation,
      manager: user.manager,
      phone: user.phone,
      avatar_url: user.avatar_url,
      status: user.status,
      must_setup_password: user.must_setup_password,
    },
    role: user.role_table_id
      ? { id: user.role_table_id, name: user.role_name, description: user.role_description }
      : null,
    permissions,
    permissionMeta,
  };
}

async function hasPermission(userId, moduleSlug) {
  const authz = await getUserAuthorization(userId);
  return Boolean(authz && authz.permissions.includes(moduleSlug));
}

module.exports = { getUserAuthorization, hasPermission };
