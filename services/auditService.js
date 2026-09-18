const db = require('../config/database');

async function addAuditLog({ user, action, details, targetId }) {
  const publicId = `LOG-${Date.now()}`;
  await db.query(
    `INSERT INTO audit_logs (public_id, user_name, user_email, role_label, action, details, target_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      publicId,
      user?.name || 'System',
      user?.email || 'system@integriti.io',
      user?.role?.name || 'System',
      action,
      details,
      targetId || 'N/A',
    ]
  );
}

async function addNotification({ targetEmail, subject, text, type = 'info' }) {
  const publicId = `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await db.query(
    `INSERT INTO notifications (public_id, target_email, subject, text, type)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, (targetEmail || '').toLowerCase(), subject, text, type]
  );
}

function publicId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}-${stamp}${Math.floor(Math.random() * 90 + 10)}`;
}

module.exports = { addAuditLog, addNotification, publicId };
