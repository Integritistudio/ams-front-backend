require('dotenv').config();
const db = require('../config/database');

const SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_it_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_approver BOOLEAN NOT NULL DEFAULT FALSE,
  is_executive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS modules (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  icon VARCHAR(80),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id SERIAL PRIMARY KEY,
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module_id INT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  can_view_all BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(role_id, module_id)
);

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255),
  department VARCHAR(160),
  designation VARCHAR(160),
  manager VARCHAR(160),
  phone VARCHAR(80),
  avatar_url TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'Active',
  role_id INT REFERENCES roles(id) ON DELETE SET NULL,
  must_setup_password BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  purpose VARCHAR(40) NOT NULL DEFAULT 'reset',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id SERIAL PRIMARY KEY,
  type VARCHAR(40) NOT NULL,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  requester_id INT REFERENCES users(id) ON DELETE SET NULL,
  requester_name VARCHAR(160) NOT NULL,
  requester_email VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  category VARCHAR(120),
  other_category VARCHAR(160),
  department VARCHAR(160),
  priority VARCHAR(40) NOT NULL DEFAULT 'Medium',
  status VARCHAR(60) NOT NULL DEFAULT 'Assigned',
  description TEXT,
  assigned_to VARCHAR(200),
  attachment_url TEXT,
  hold_reason TEXT,
  created_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_timestamp TIMESTAMPTZ,
  created_at DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_replies (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author VARCHAR(160) NOT NULL,
  role_label VARCHAR(80),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS requisitions (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  requester_id INT REFERENCES users(id) ON DELETE SET NULL,
  requester_name VARCHAR(160) NOT NULL,
  requester_email VARCHAR(255) NOT NULL,
  department VARCHAR(160),
  approver_id INT REFERENCES users(id) ON DELETE SET NULL,
  approver_name VARCHAR(160),
  type VARCHAR(40) NOT NULL,
  item TEXT NOT NULL,
  project TEXT,
  urgency VARCHAR(40) NOT NULL DEFAULT 'Standard',
  justification TEXT,
  status VARCHAR(80) NOT NULL DEFAULT 'Pending Manager Approval',
  attachment_url TEXT,
  hold_reason TEXT,
  decision_history TEXT,
  fulfillment_details JSONB,
  created_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_timestamp TIMESTAMPTZ,
  created_at DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS requisition_replies (
  id SERIAL PRIMARY KEY,
  requisition_id INT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  author VARCHAR(160) NOT NULL,
  role_label VARCHAR(80),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(80) NOT NULL,
  contact TEXT,
  status VARCHAR(40) NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS procurement_logs (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  source_req_id INT REFERENCES requisitions(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  vendor VARCHAR(200),
  cost VARCHAR(80),
  brand VARCHAR(160),
  serial_number VARCHAR(160),
  approval_date DATE,
  delivery_date DATE,
  approver VARCHAR(160),
  assigned_user_email VARCHAR(255),
  department VARCHAR(160),
  description TEXT,
  status VARCHAR(80) NOT NULL DEFAULT 'Delivered / Fulfilled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_assets (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(255) NOT NULL,
  asset_code VARCHAR(80) NOT NULL,
  category VARCHAR(80) NOT NULL,
  name TEXT NOT NULL,
  brand VARCHAR(160),
  serial_number VARCHAR(160),
  assigned_date DATE,
  note TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  category VARCHAR(80) NOT NULL,
  icon VARCHAR(80),
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'Active',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  target_email VARCHAR(255) NOT NULL,
  subject TEXT NOT NULL,
  text TEXT,
  type VARCHAR(40) NOT NULL DEFAULT 'info',
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  user_name VARCHAR(160),
  user_email VARCHAR(255),
  role_label VARCHAR(80),
  action VARCHAR(160) NOT NULL,
  details TEXT,
  target_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  logo_url TEXT,
  color_primary VARCHAR(20) DEFAULT '#2563eb',
  color_accent VARCHAR(20) DEFAULT '#06b6d4',
  color_text VARCHAR(20) DEFAULT '#f8fafc',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_smtp_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  host VARCHAR(255),
  port INT DEFAULT 587,
  secure BOOLEAN NOT NULL DEFAULT FALSE,
  username VARCHAR(255),
  password TEXT,
  from_name VARCHAR(160) DEFAULT 'IT Service Desk',
  from_email VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Encrypted file blobs (AES-256-GCM). Tickets/requisitions store download URL in attachment_url.
CREATE TABLE IF NOT EXISTS file_attachments (
  id SERIAL PRIMARY KEY,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INT NOT NULL DEFAULT 0,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  uploaded_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Legacy table (unused): encryption key is env-only via FILE_ENCRYPTION_KEY
CREATE TABLE IF NOT EXISTS file_encryption_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  encryption_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin-managed OpenAI key for "Improve with AI"
CREATE TABLE IF NOT EXISTS openai_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_key TEXT,
  model VARCHAR(80) DEFAULT 'gpt-4o-mini',
  provider VARCHAR(40) DEFAULT 'openai',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_tickets_email ON tickets(requester_email);
CREATE INDEX IF NOT EXISTS idx_requisitions_approver ON requisitions(approver_id);
CREATE INDEX IF NOT EXISTS idx_notifications_email ON notifications(target_email);
CREATE INDEX IF NOT EXISTS idx_password_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_file_attachments_uploader ON file_attachments(uploaded_by);

ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_it_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_approver BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_executive BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep only the lowest-id role for each special flag (cleanup before unique indexes)
UPDATE roles SET is_it_admin = FALSE
WHERE is_it_admin = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM roles WHERE is_it_admin = TRUE) t);
UPDATE roles SET is_approver = FALSE
WHERE is_approver = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM roles WHERE is_approver = TRUE) t);

-- A role cannot be both IT Admin and Approver
UPDATE roles SET is_approver = FALSE WHERE is_it_admin = TRUE AND is_approver = TRUE;

-- Hard guarantee: at most one IT Admin role and one Approver role in the system
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_one_it_admin
  ON roles ((TRUE)) WHERE is_it_admin = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_one_approver
  ON roles ((TRUE)) WHERE is_approver = TRUE;

-- Approval Asset: every role can open the tab (visibility of rows still filtered by role flags).
INSERT INTO role_permissions (role_id, module_id, can_view_all)
SELECT r.id, m.id, FALSE
FROM roles r
CROSS JOIN modules m
WHERE m.slug = 'approvals'
  AND m.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.module_id = m.id
  );
-- Soft-delete support for users (keep tickets/requests/assets linked)
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Email templates bound to notification events + on/off triggers
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS event_key VARCHAR(80);
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS use_custom BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_event_key_uidx
  ON email_templates (event_key) WHERE event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_triggers (
  event_key VARCHAR(80) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Display names for sidebar / role permission matrix
UPDATE modules SET name = 'Asset Requests' WHERE slug = 'requisitions';
UPDATE modules SET name = 'Pending Approvals' WHERE slug = 'approvals';

-- Product rename: Integriti IT Helpdesk → IT Service Desk
UPDATE email_smtp_settings
SET from_name = 'IT Service Desk'
WHERE from_name IS NULL
   OR from_name = ''
   OR from_name ILIKE '%Integriti%Helpdesk%'
   OR from_name = 'Integriti IT Helpdesk';

-- ========== Enterprise portal v2: roles, manager graph, inventory, workflow ==========
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_hr_manager BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_finance_manager BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_gm BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE roles SET is_hr_manager = FALSE
WHERE is_hr_manager = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM roles WHERE is_hr_manager = TRUE) t);
UPDATE roles SET is_finance_manager = FALSE
WHERE is_finance_manager = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM roles WHERE is_finance_manager = TRUE) t);
UPDATE roles SET is_gm = FALSE
WHERE is_gm = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM roles WHERE is_gm = TRUE) t);

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_one_hr_manager
  ON roles ((TRUE)) WHERE is_hr_manager = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_one_finance_manager
  ON roles ((TRUE)) WHERE is_finance_manager = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_one_gm
  ON roles ((TRUE)) WHERE is_gm = TRUE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users(manager_id);

ALTER TABLE portal_settings ADD COLUMN IF NOT EXISTS hr_approval_limit NUMERIC(14,2) DEFAULT 50000;
ALTER TABLE portal_settings ADD COLUMN IF NOT EXISTS gm_approval_limit NUMERIC(14,2) DEFAULT 200000;
ALTER TABLE portal_settings ADD COLUMN IF NOT EXISTS session_timeout_minutes INT DEFAULT 30;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS can_export BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO portal_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
UPDATE portal_settings SET
  hr_approval_limit = COALESCE(hr_approval_limit, 50000),
  gm_approval_limit = COALESCE(gm_approval_limit, 200000),
  session_timeout_minutes = COALESCE(session_timeout_minutes, 30)
WHERE id = 1;

-- Default: admin-style roles may export; Staff stays false unless Super Admin enables it
UPDATE roles SET can_export = TRUE
WHERE can_export = FALSE
  AND (
    COALESCE(is_it_admin, FALSE) = TRUE
    OR COALESCE(is_hr_manager, FALSE) = TRUE
    OR COALESCE(is_finance_manager, FALSE) = TRUE
    OR COALESCE(is_gm, FALSE) = TRUE
    OR COALESCE(is_executive, FALSE) = TRUE
    OR COALESCE(is_super_admin_role, FALSE) = TRUE
  );

CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  public_id VARCHAR(40) NOT NULL UNIQUE,
  catalog_item_id INT REFERENCES catalog_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type VARCHAR(40) NOT NULL DEFAULT 'Hardware',
  quantity_available INT NOT NULL DEFAULT 0,
  quantity_reserved INT NOT NULL DEFAULT 0,
  unit VARCHAR(40) DEFAULT 'unit',
  location VARCHAR(160),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_name ON inventory_items (LOWER(name));

ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS total_price NUMERIC(14,2);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS catalog_item_id INT REFERENCES catalog_items(id) ON DELETE SET NULL;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS inventory_available BOOLEAN;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS vendor_quotes JSONB;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS current_stage VARCHAR(80);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS line_manager_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS linked_asset_ids JSONB DEFAULT '[]'::jsonb;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS line_manager_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority_set_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tickets ALTER COLUMN priority DROP DEFAULT;
-- Allow null priority until Line Manager sets it (existing rows keep values)
ALTER TABLE tickets ALTER COLUMN priority DROP NOT NULL;

ALTER TABLE user_assets ADD COLUMN IF NOT EXISTS source_req_id INT REFERENCES requisitions(id) ON DELETE SET NULL;
ALTER TABLE user_assets ADD COLUMN IF NOT EXISTS source_req_public_id VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_user_assets_source_req ON user_assets(source_req_id);

INSERT INTO modules (slug, name, icon, sort_order, is_active)
SELECT 'inventory', 'Inventory Management', 'fa-boxes-stacked', 55, TRUE
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'inventory');

INSERT INTO role_permissions (role_id, module_id, can_view_all)
SELECT r.id, m.id, TRUE
FROM roles r
CROSS JOIN modules m
WHERE m.slug = 'inventory'
  AND r.is_it_admin = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.module_id = m.id
  );

-- Analytics module (full charts / export) — mirror dashboard access for every role
INSERT INTO modules (slug, name, icon, sort_order, is_active)
SELECT 'analytics', 'Analytics', 'fa-chart-line', 2, TRUE
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'analytics');

UPDATE modules SET sort_order = 2, name = 'Analytics', icon = 'fa-chart-line'
WHERE slug = 'analytics';

INSERT INTO role_permissions (role_id, module_id, can_view_all)
SELECT r.id, m_analytics.id, COALESCE(rp_dash.can_view_all, FALSE)
FROM roles r
CROSS JOIN modules m_analytics
LEFT JOIN modules m_dash ON m_dash.slug = 'dashboard'
LEFT JOIN role_permissions rp_dash
  ON rp_dash.role_id = r.id AND rp_dash.module_id = m_dash.id
WHERE m_analytics.slug = 'analytics'
  AND (
    rp_dash.id IS NOT NULL
    OR COALESCE(r.is_super_admin_role, FALSE) = TRUE
  )
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.module_id = m_analytics.id
  );

-- Also grant analytics to every role that has any permissions (staff with dashboard)
INSERT INTO role_permissions (role_id, module_id, can_view_all)
SELECT DISTINCT rp.role_id, m.id, FALSE
FROM role_permissions rp
CROSS JOIN modules m
WHERE m.slug = 'analytics'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x
    WHERE x.role_id = rp.role_id AND x.module_id = m.id
  );

-- Role flags are designations on roles, not singletons — many users may share them
DROP INDEX IF EXISTS uq_roles_one_it_admin;
DROP INDEX IF EXISTS uq_roles_one_approver;
DROP INDEX IF EXISTS uq_roles_one_hr_manager;
DROP INDEX IF EXISTS uq_roles_one_finance_manager;
DROP INDEX IF EXISTS uq_roles_one_gm;

-- Approver role removed from product — clear any remaining flags
UPDATE roles SET is_approver = FALSE WHERE is_approver = TRUE;

-- ========== Super Admin (single person) ==========
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_super_admin_role BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users SET is_super_admin = FALSE
WHERE is_super_admin = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM users WHERE is_super_admin = TRUE) t);
UPDATE roles SET is_super_admin_role = FALSE
WHERE is_super_admin_role = TRUE
  AND id NOT IN (SELECT id FROM (SELECT MIN(id) AS id FROM roles WHERE is_super_admin_role = TRUE) t);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_one_super_admin
  ON users ((TRUE)) WHERE is_super_admin = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_one_super_admin_role
  ON roles ((TRUE)) WHERE is_super_admin_role = TRUE;

-- Settings / Email Settings are Super Admin only — strip from all other roles
DELETE FROM role_permissions rp
USING modules m, roles r
WHERE rp.module_id = m.id
  AND rp.role_id = r.id
  AND m.slug IN ('settings', 'email_settings')
  AND COALESCE(r.is_super_admin_role, FALSE) = FALSE;
`;

async function migrate() {
  console.log('Running migrations...');
  await db.query(SQL);
  const { bootstrapSuperAdmin } = require('../services/superAdminBootstrap');
  await bootstrapSuperAdmin();
  console.log('Migrations completed successfully.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
