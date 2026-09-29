const bcrypt = require('bcryptjs');
const db = require('../config/database');

/**
 * Bootstrap the single Super Admin from SUPER_ADMIN_EMAIL (env).
 *
 * Password options:
 * 1) SUPER_ADMIN_PASSWORD in .env — first login uses .env (hash stays empty until My Account change)
 * 2) No password — generates a one-time setup link (printed to console; emailed if SMTP works)
 * 3) SUPER_ADMIN_FORCE_PASSWORD=1 — emergency: write env password into DB
 *
 * Does not move Super Admin if one already exists (unless SUPER_ADMIN_FORCE=1).
 */
async function bootstrapSuperAdmin() {
  const emailRaw = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!emailRaw) {
    console.log(
      'Super Admin: SUPER_ADMIN_EMAIL not set — skipping bootstrap. Set it in .env then re-run migrate.'
    );
    return { skipped: true };
  }

  const force = String(process.env.SUPER_ADMIN_FORCE || '').trim() === '1';
  const existingSa = await db.query(
    `SELECT id, email, name, password_hash FROM users WHERE is_super_admin = TRUE LIMIT 1`
  );

  if (existingSa.rows[0] && !force) {
    console.log(
      `Super Admin: already locked to ${existingSa.rows[0].email} (id=${existingSa.rows[0].id}).`
    );
    await ensureSuperAdminRole();
    if (!existingSa.rows[0].password_hash) {
      await ensurePasswordOrSetupLink(existingSa.rows[0]);
    }
    return { skipped: true, existing: existingSa.rows[0] };
  }

  const roleId = await ensureSuperAdminRole();
  const name =
    (process.env.SUPER_ADMIN_NAME || '').trim() ||
    emailRaw.split('@')[0] ||
    'Super Admin';

  let user = (
    await db.query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [emailRaw])
  ).rows[0];

  if (!user) {
    const created = await db.query(
      `INSERT INTO users (
         email, name, password_hash, department, designation, status, role_id,
         must_setup_password, is_super_admin
       ) VALUES ($1,$2,NULL,'Administration','Super Admin','Active',$3,TRUE,TRUE)
       RETURNING *`,
      [emailRaw, name, roleId]
    );
    user = created.rows[0];
    console.log(`Super Admin: created user ${emailRaw}`);
  } else {
    await db.query(
      `UPDATE users SET
         role_id = $2,
         is_super_admin = TRUE,
         status = 'Active',
         deleted_at = NULL,
         name = COALESCE(NULLIF($3, ''), name),
         updated_at = NOW()
       WHERE id = $1`,
      [user.id, roleId, name]
    );
    user = (await db.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0];
    console.log(`Super Admin: promoted existing user ${emailRaw}.`);
  }

  await db.query(
    `UPDATE users SET is_super_admin = FALSE, updated_at = NOW()
     WHERE is_super_admin = TRUE AND id <> $1`,
    [user.id]
  );

  await stripSettingsFromNonSuperRoles(roleId);
  await ensurePasswordOrSetupLink(user);

  return { created: true, userId: user.id, email: emailRaw, roleId };
}

/**
 * Password flow for Super Admin:
 * 1) SUPER_ADMIN_PASSWORD in .env + no password_hash → login checks .env (not written to DB)
 * 2) After My Account → Change Password → password_hash in DB; login uses DB only
 * 3) SUPER_ADMIN_FORCE_PASSWORD=1 → emergency reset: copy env into DB (overwrites)
 * 4) No env password and no DB hash → one-time setup link
 */
async function ensurePasswordOrSetupLink(user) {
  if (!user?.id) return;

  const forcePwd = String(process.env.SUPER_ADMIN_FORCE_PASSWORD || '').trim() === '1';
  const plain = (process.env.SUPER_ADMIN_PASSWORD || '').trim();

  const fresh = (await db.query(`SELECT password_hash FROM users WHERE id = $1`, [user.id])).rows[0];
  const hasDbPassword = Boolean(fresh?.password_hash);

  // Emergency only: force env password into DB (recovery)
  if (forcePwd && plain) {
    if (plain.length < 8) {
      console.warn('Super Admin: SUPER_ADMIN_FORCE_PASSWORD ignored (password must be at least 8 characters).');
    } else {
      const hash = await bcrypt.hash(plain, 10);
      await db.query(
        `UPDATE users SET password_hash = $2, must_setup_password = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [user.id, hash]
      );
      console.log(
        'Super Admin: password FORCE-reset from SUPER_ADMIN_PASSWORD into DB. ' +
          'Remove SUPER_ADMIN_FORCE_PASSWORD=1 from .env after login.'
      );
      return;
    }
  }

  if (hasDbPassword) {
    console.log(
      'Super Admin: password is stored in DB (set via profile or setup). Login uses DB — env password is ignored.'
    );
    return;
  }

  if (plain) {
    if (plain.length < 8) {
      console.warn(
        'Super Admin: SUPER_ADMIN_PASSWORD must be at least 8 characters. Using setup link instead.'
      );
    } else {
      // Keep password_hash NULL — first login authenticates against .env until they change it in My Account
      await db.query(
        `UPDATE users SET must_setup_password = TRUE, updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      console.log(
        'Super Admin: log in with SUPER_ADMIN_PASSWORD from .env (not stored in DB yet). ' +
          'After you change the password in My Account, login uses the DB hash only — then remove SUPER_ADMIN_PASSWORD from .env.'
      );
      return;
    }
  }

  // One-time setup link (works without SMTP; link is always printed)
  try {
    const authService = require('./authService');
    const result = await authService.sendSetupOrResetEmail(user.id, 'setup');
    console.log('----------------------------------------------------------');
    console.log('Super Admin: no password yet — open this link to set one:');
    console.log(result.setupUrl);
    if (result.delivered) {
      console.log('(Also emailed successfully.)');
    } else {
      console.log('(SMTP not delivering — use the URL above. Configure Email Settings after login.)');
    }
    console.log('----------------------------------------------------------');
  } catch (err) {
    console.error('Super Admin: could not create setup link:', err.message);
  }
}

async function ensureSuperAdminRole() {
  let role = (
    await db.query(`SELECT id FROM roles WHERE is_super_admin_role = TRUE LIMIT 1`)
  ).rows[0];

  if (!role) {
    const byName = await db.query(
      `SELECT id FROM roles WHERE LOWER(name) = 'super admin' LIMIT 1`
    );
    if (byName.rows[0]) {
      await db.query(
        `UPDATE roles SET is_super_admin_role = TRUE, is_it_admin = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [byName.rows[0].id]
      );
      role = byName.rows[0];
    } else {
      const created = await db.query(
        `INSERT INTO roles (name, description, is_active, is_super_admin_role, is_it_admin)
         VALUES ('Super Admin', 'Full system control — one designated person', TRUE, TRUE, FALSE)
         RETURNING id`
      );
      role = created.rows[0];
    }
  }

  await db.query(
    `UPDATE roles SET is_super_admin_role = FALSE WHERE id <> $1 AND is_super_admin_role = TRUE`,
    [role.id]
  );

  const modules = await db.query(`SELECT id FROM modules WHERE is_active = TRUE`);
  for (const m of modules.rows) {
    await db.query(
      `INSERT INTO role_permissions (role_id, module_id, can_view_all)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (role_id, module_id) DO UPDATE SET can_view_all = TRUE`,
      [role.id, m.id]
    );
  }

  return role.id;
}

async function stripSettingsFromNonSuperRoles(superRoleId) {
  await db.query(
    `DELETE FROM role_permissions rp
     USING modules m
     WHERE rp.module_id = m.id
       AND m.slug IN ('settings', 'email_settings')
       AND rp.role_id <> $1`,
    [superRoleId]
  );
}

module.exports = {
  bootstrapSuperAdmin,
  ensureSuperAdminRole,
  stripSettingsFromNonSuperRoles,
};
