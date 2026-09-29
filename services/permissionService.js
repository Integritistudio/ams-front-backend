const db = require('../config/database');

async function getUserAuthorization(userId) {
  const userResult = await db.query(
    `SELECT u.id, u.email, u.name, u.department, u.designation, u.manager, u.manager_id, u.phone,
            u.avatar_url, u.status, u.role_id, u.must_setup_password,
            COALESCE(u.is_super_admin, FALSE) AS is_super_admin,
            r.id AS role_table_id, r.name AS role_name, r.description AS role_description,
            COALESCE(r.is_it_admin, FALSE) AS is_it_admin,
            FALSE AS is_approver,
            COALESCE(r.is_executive, FALSE) AS is_executive,
            COALESCE(r.is_hr_manager, FALSE) AS is_hr_manager,
            COALESCE(r.is_finance_manager, FALSE) AS is_finance_manager,
            COALESCE(r.is_gm, FALSE) AS is_gm,
            COALESCE(r.is_super_admin_role, FALSE) AS is_super_admin_role,
            COALESCE(r.can_export, FALSE) AS can_export,
            m.name AS manager_user_name, m.email AS manager_user_email
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN users m ON m.id = u.manager_id
     WHERE u.id = $1`,
    [userId]
  );

  const user = userResult.rows[0];
  if (!user || user.status !== 'Active') return null;

  const isSuperAdmin = Boolean(user.is_super_admin);

  let permissionMeta;
  if (isSuperAdmin) {
    const all = await db.query(
      `SELECT slug, name, TRUE AS can_view_all
       FROM modules WHERE is_active = TRUE
       ORDER BY sort_order ASC, name ASC`
    );
    permissionMeta = all.rows;
  } else {
    const permResult = await db.query(
      `SELECT m.slug, m.name, rp.can_view_all
       FROM role_permissions rp
       JOIN modules m ON m.id = rp.module_id
       WHERE rp.role_id = $1 AND m.is_active = TRUE`,
      [user.role_id]
    );
    // Never expose settings / email_settings except Super Admin
    permissionMeta = permResult.rows.filter(
      (p) => p.slug !== 'settings' && p.slug !== 'email_settings'
    );
  }

  const permissions = permissionMeta.map((p) => p.slug);
  const canExport = isSuperAdmin || Boolean(user.can_export);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      department: user.department,
      designation: user.designation,
      manager: user.manager_user_name || user.manager,
      manager_id: user.manager_id || null,
      phone: user.phone,
      avatar_url: user.avatar_url,
      status: user.status,
      must_setup_password: user.must_setup_password,
      is_super_admin: isSuperAdmin,
    },
    role: user.role_table_id
      ? {
          id: user.role_table_id,
          name: user.role_name,
          description: user.role_description,
          is_it_admin: Boolean(user.is_it_admin),
          is_executive: Boolean(user.is_executive),
          is_hr_manager: Boolean(user.is_hr_manager),
          is_finance_manager: Boolean(user.is_finance_manager),
          is_gm: Boolean(user.is_gm),
          is_super_admin_role: Boolean(user.is_super_admin_role),
          can_export: canExport,
        }
      : null,
    permissions,
    permissionMeta,
    can_export: canExport,
    is_super_admin: isSuperAdmin,
  };
}

async function hasPermission(userId, moduleSlug) {
  const authz = await getUserAuthorization(userId);
  return Boolean(authz && authz.permissions.includes(moduleSlug));
}

async function getApprovalLimits() {
  const result = await db.query(
    `SELECT hr_approval_limit, gm_approval_limit FROM portal_settings WHERE id = 1`
  );
  const row = result.rows[0] || {};
  return {
    hr_approval_limit: Number(row.hr_approval_limit ?? 50000),
    gm_approval_limit: Number(row.gm_approval_limit ?? 200000),
  };
}

function isSuperAdmin(req) {
  return Boolean(req.authz?.is_super_admin || req.authz?.user?.is_super_admin);
}

module.exports = {
  getUserAuthorization,
  hasPermission,
  getApprovalLimits,
  isSuperAdmin,
};
