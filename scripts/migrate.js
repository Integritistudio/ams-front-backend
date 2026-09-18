require('dotenv').config();
const db = require('../config/database');

const SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
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

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_tickets_email ON tickets(requester_email);
CREATE INDEX IF NOT EXISTS idx_requisitions_approver ON requisitions(approver_id);
CREATE INDEX IF NOT EXISTS idx_notifications_email ON notifications(target_email);
CREATE INDEX IF NOT EXISTS idx_password_tokens_user ON password_reset_tokens(user_id);
`;

async function migrate() {
  console.log('Running migrations...');
  await db.query(SQL);
  console.log('Migrations completed successfully.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
