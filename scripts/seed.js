require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

// Seed is for local/dev sample data only.
// On production set NODE_ENV=production in .env — then npm run seed exits and does nothing.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== 'true') {
  console.error('Seed blocked: NODE_ENV=production.');
  console.error('Do not run npm run seed on production.');
  console.error('Create admin/users with SQL or the admin UI instead.');
  process.exit(1);
}

const MODULES = [
  { slug: 'dashboard', name: 'Home Dashboard', icon: 'fa-house', sort_order: 1 },
  { slug: 'tickets', name: 'Support Tickets', icon: 'fa-ticket', sort_order: 2 },
  { slug: 'requisitions', name: 'New Asset Request', icon: 'fa-cart-flatbed', sort_order: 3 },
  { slug: 'approvals', name: 'Approval Asset', icon: 'fa-clipboard-check', sort_order: 4 },
  { slug: 'my_assets', name: 'Assigned Assets', icon: 'fa-laptop-code', sort_order: 5 },
  { slug: 'procurement_log', name: 'Procurement Log', icon: 'fa-file-invoice-dollar', sort_order: 6 },
  { slug: 'logs', name: 'My Logs', icon: 'fa-clock-rotate-left', sort_order: 7 },
  { slug: 'account', name: 'My Account', icon: 'fa-user-gear', sort_order: 8 },
  { slug: 'knowledge_base', name: 'Knowledge Base', icon: 'fa-book-open', sort_order: 9 },
  { slug: 'assign_assets', name: 'Assign Assets', icon: 'fa-box-open', sort_order: 10 },
  { slug: 'vendors', name: 'Approved Vendors', icon: 'fa-store', sort_order: 11 },
  { slug: 'settings', name: 'Settings', icon: 'fa-gear', sort_order: 12 },
  { slug: 'users', name: 'User Management', icon: 'fa-users-gear', sort_order: 13 },
  { slug: 'roles', name: 'Role Management', icon: 'fa-user-shield', sort_order: 14 },
  { slug: 'email_settings', name: 'Email Settings', icon: 'fa-envelope-open-text', sort_order: 15 },
];

const DEPARTMENTS = [
  'IT & Software Engineering',
  'Human Resources',
  'Finance',
  'Sales',
  'Executive Board',
  'Sales & Digital Marketing',
  'Business Development',
  'People Growth',
  'SAP',
  'Operations',
  'Management',
  'Corporate Service',
];

const HARDWARE = [
  'Laptop: Standard Workstation (16GB RAM / Core i7)',
  'Laptop: High Performance / Development (32GB RAM)',
  'Desktop Monitor: Dell 24-inch FHD Display',
  'Desktop Monitor: 27-inch 2K High-Res Display',
  'Peripherals: Wireless Keyboard & Mouse Combo',
  'Accessories: USB-C Multiport Hub / Docking Station',
  'Accessories: HDMI / DisplayPort Cable Replacement',
  'Audio: Noise-Cancelling Office Headset with Mic',
  'Other Hardware Item (Specify Below)',
];

const SOFTWARE = [
  'Microsoft 365 Business Premium License Add-on',
  'JetBrains All Products Pack / IDE License',
  'Adobe Creative Cloud All Apps Subscription',
  'Cloud Storage: Dropbox Business / 1TB Allocation',
  'SAP User Access License & Role Assignment',
  'VPN Dedicated IP & SSL Remote Client License',
  'Other Software License (Specify Below)',
];

// Local-only dummy users. Use getnada.com (or another disposable inbox) so
// password-setup / notification emails never hit real corporate addresses.
// Create matching inboxes at https://getnada.com when you want to receive test mail.
const SEED_EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN || 'getnada.com';

const DIRECTORY = [
  { local: 'admin', name: 'Demo IT Admin', dept: 'IT & Software Engineering', role: 'IT Admin', designation: 'Technical Support Specialist', manager: 'Demo Executive' },
  { local: 'it.admin', name: 'Demo Support Agent', dept: 'IT & Software Engineering', role: 'IT Admin', designation: 'Helpdesk Admin', manager: 'Demo Executive' },
  { local: 'executive', name: 'Demo Executive', dept: 'Executive Board', role: 'Executive Lead', designation: 'Approver', manager: 'Board' },
  { local: 'approver', name: 'Demo Approver', dept: 'IT & Software Engineering', role: 'Executive Lead', designation: 'Manager', manager: 'Demo Executive' },
  { local: 'staff', name: 'Demo Staff User', dept: 'IT & Software Engineering', role: 'Staff', designation: 'Software Engineer', manager: 'Demo Approver' },
  { local: 'hr.user', name: 'Demo HR User', dept: 'Human Resources', role: 'Staff', designation: 'HR Associate', manager: 'Demo Executive' },
  { local: 'finance.user', name: 'Demo Finance User', dept: 'Finance', role: 'Staff', designation: 'Finance Executive', manager: 'Demo Executive' },
  { local: 'sales.user', name: 'Demo Sales User', dept: 'Sales', role: 'Staff', designation: 'Sales Representative', manager: 'Demo Approver' },
].map((u) => ({
  ...u,
  email: `${u.local}@${SEED_EMAIL_DOMAIN}`.toLowerCase(),
}));

const STAFF_MODULES = ['dashboard', 'tickets', 'requisitions', 'my_assets', 'logs', 'account', 'knowledge_base'];
const EXEC_MODULES = [...STAFF_MODULES, 'approvals', 'procurement_log'];
const ADMIN_MODULES = MODULES.map((m) => m.slug);
const VIEW_ALL_MODULES = ['tickets', 'requisitions', 'logs', 'procurement_log', 'my_assets'];

async function seed() {
  console.log('Seeding database...');

  for (const m of MODULES) {
    await db.query(
      `INSERT INTO modules (slug, name, icon, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order`,
      [m.slug, m.name, m.icon, m.sort_order]
    );
  }

  const roleDefs = [
    { name: 'IT Admin', description: 'Full IT Helpdesk administration' },
    { name: 'Executive Lead', description: 'Approvals and oversight' },
    { name: 'Staff', description: 'Standard employee access' },
  ];

  const roleIds = {};
  for (const r of roleDefs) {
    const existing = await db.query(`SELECT id FROM roles WHERE name = $1`, [r.name]);
    if (existing.rows[0]) {
      roleIds[r.name] = existing.rows[0].id;
    } else {
      const created = await db.query(
        `INSERT INTO roles (name, description) VALUES ($1,$2) RETURNING id`,
        [r.name, r.description]
      );
      roleIds[r.name] = created.rows[0].id;
    }
  }

  const modulesResult = await db.query(`SELECT id, slug FROM modules`);
  const moduleMap = Object.fromEntries(modulesResult.rows.map((m) => [m.slug, m.id]));

  async function grant(roleName, slugs) {
    const roleId = roleIds[roleName];
    await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    for (const slug of slugs) {
      const moduleId = moduleMap[slug];
      if (!moduleId) continue;
      const canViewAll = (roleName !== 'Staff') && VIEW_ALL_MODULES.includes(slug);
      await db.query(
        `INSERT INTO role_permissions (role_id, module_id, can_view_all) VALUES ($1,$2,$3)`,
        [roleId, moduleId, canViewAll]
      );
    }
  }

  await grant('Staff', STAFF_MODULES);
  await grant('Executive Lead', EXEC_MODULES);
  await grant('IT Admin', ADMIN_MODULES);

  for (const d of DEPARTMENTS) {
    await db.query(
      `INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [d]
    );
  }

  await db.query(`DELETE FROM catalog_items`);
  for (let i = 0; i < HARDWARE.length; i += 1) {
    await db.query(
      `INSERT INTO catalog_items (type, name, sort_order) VALUES ('Hardware', $1, $2)`,
      [HARDWARE[i], i]
    );
  }
  for (let i = 0; i < SOFTWARE.length; i += 1) {
    await db.query(
      `INSERT INTO catalog_items (type, name, sort_order) VALUES ('Software', $1, $2)`,
      [SOFTWARE[i], i]
    );
  }

  // Passwords are never hard-coded. Optional local-only env hashes:
  // SEED_ADMIN_PASSWORD / SEED_USER_PASSWORD in .env (do not commit real secrets).
  // Otherwise password_hash stays NULL — set later via SQL, admin UI, or password-setup email.
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || null;
  const userPassword = process.env.SEED_USER_PASSWORD || null;
  const adminHash = adminPassword ? await bcrypt.hash(adminPassword, 10) : null;
  const userHash = userPassword ? await bcrypt.hash(userPassword, 10) : null;

  for (const u of DIRECTORY) {
    const roleId = roleIds[u.role];
    const hash = u.role === 'IT Admin' ? adminHash : userHash;
    const mustSetup = !hash;
    await db.query(
      `INSERT INTO users (email, name, password_hash, department, designation, manager, status, role_id, must_setup_password)
       VALUES ($1,$2,$3,$4,$5,$6,'Active',$7,$8)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         department = EXCLUDED.department,
         designation = EXCLUDED.designation,
         manager = EXCLUDED.manager,
         role_id = EXCLUDED.role_id,
         password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
         must_setup_password = CASE
           WHEN users.password_hash IS NULL AND EXCLUDED.password_hash IS NULL THEN TRUE
           WHEN users.password_hash IS NULL AND EXCLUDED.password_hash IS NOT NULL THEN FALSE
           ELSE users.must_setup_password
         END`,
      [u.email.toLowerCase(), u.name, hash, u.dept, u.designation, u.manager, roleId, mustSetup]
    );
  }

  await db.query(
    `INSERT INTO portal_settings (id, color_primary, color_accent, color_text)
     VALUES (1, '#2563eb', '#06b6d4', '#f8fafc')
     ON CONFLICT (id) DO NOTHING`
  );

  const kbCount = await db.query(`SELECT COUNT(*)::int AS c FROM kb_articles`);
  if (kbCount.rows[0].c === 0) {
    const articles = [
      {
        id: 'KB-101', category: 'Network', icon: 'fa-shield-halved',
        title: 'Fortinet SSL VPN Disconnection / 48% Error',
        summary: 'Fix SSL VPN client getting stuck at 48% or dropping connection after login.',
        content: '1. Open FortiClient and verify Remote Gateway IP.\n2. Flush DNS: ipconfig /flushdns\n3. Disable IPv6 on active adapter.\n4. Restart FortiClient or reboot.\n5. If still stuck at 48%, request gateway reset from IT.',
      },
      {
        id: 'KB-102', category: 'M365', icon: 'fa-envelope-open-text',
        title: 'Outlook Disconnected & Repeated MFA Loop',
        summary: 'Resolve Outlook client password prompts and Microsoft 365 credential loops.',
        content: '1. Close Outlook.\n2. Remove MicrosoftOffice16 / ADAL credentials from Credential Manager.\n3. Confirm Work or School account is connected.\n4. Relaunch Outlook and approve Authenticator prompt.',
      },
      {
        id: 'KB-103', category: 'Hardware', icon: 'fa-desktop',
        title: 'Secondary Monitor No Signal / HDMI Detection',
        summary: 'Troubleshoot external Dell/HP displays not detecting video input.',
        content: '1. Press Win+P and select Extend.\n2. Power-cycle the monitor for 15 seconds.\n3. Reseat HDMI/USB-C dock.\n4. Set monitor input explicitly to HDMI-1 or DP.',
      },
      {
        id: 'KB-104', category: 'Security', icon: 'fa-key',
        title: 'Domain Password Expiry & Self-Reset Guide',
        summary: 'Rules and process for resetting your Integriti corporate password.',
        content: '1. Passwords expire every 90 days.\n2. Minimum 12 characters with mixed complexity.\n3. Use corporate self-reset portal if locked out.\n4. Raise a ticket if unlock does not complete within 5 minutes.',
      },
    ];
    for (const a of articles) {
      await db.query(
        `INSERT INTO kb_articles (public_id, category, icon, title, summary, content)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [a.id, a.category, a.icon, a.title, a.summary, a.content]
      );
    }
  }

  const vendorCount = await db.query(`SELECT COUNT(*)::int AS c FROM vendors`);
  if (vendorCount.rows[0].c === 0) {
    const vendors = [
      { id: 'VND-101', name: 'Pak Computers Lahore', category: 'Hardware', contact: 'Ali Khan (+92 300 1234567)', notes: 'Authorized Dell & HP corporate partner.' },
      { id: 'VND-102', name: 'InfoTech Solutions', category: 'Software License', contact: 'Sara Ahmed (+92 42 3588900)', notes: 'Microsoft & Adobe enterprise reseller.' },
      { id: 'VND-103', name: 'TechAccess Pakistan', category: 'Peripherals', contact: 'Usman Ghani (+92 321 9876543)', notes: 'Network accessories and docking stations.' },
    ];
    for (const v of vendors) {
      await db.query(
        `INSERT INTO vendors (public_id, name, category, contact, status, notes)
         VALUES ($1,$2,$3,$4,'Active',$5)`,
        [v.id, v.name, v.category, v.contact, v.notes]
      );
    }
  }

  const tplCount = await db.query(`SELECT COUNT(*)::int AS c FROM email_templates`);
  if (tplCount.rows[0].c === 0) {
    await db.query(
      `INSERT INTO email_templates (public_id, name, subject, body, status)
       VALUES ('TPL-20260105051612', 'Ticket Solved Done',
         'Your Ticket ({{ticketId}}) is Solved!',
         'Hello {{requesterName}},\n\nYour support ticket {{ticketId}} regarding ''{{subject}}'' has been marked as resolved and closed.\n\nBest regards,\nIntegriti IT Support',
         'Active')`
    );
  }

  console.log('Seed completed.');
  console.log(`Dummy users use @${SEED_EMAIL_DOMAIN} (safe for email testing via Getnada).`);
  console.log('Example logins after you set passwords: admin@' + SEED_EMAIL_DOMAIN + ', executive@' + SEED_EMAIL_DOMAIN + ', staff@' + SEED_EMAIL_DOMAIN);
  if (adminHash || userHash) {
    console.log('Optional SEED_* passwords from .env were hashed into the DB (not stored in source).');
  } else {
    console.log('No passwords set (password_hash is NULL). Set them via SQL, admin UI, or password-setup email.');
    console.log('Local optional: set SEED_ADMIN_PASSWORD / SEED_USER_PASSWORD in .env then re-run seed.');
  }
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
