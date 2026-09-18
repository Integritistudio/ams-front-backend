const db = require('../config/database');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function list(req, res, next) {
  try {
    const result = await db.query(
      `SELECT * FROM notifications
       WHERE LOWER(target_email) = LOWER($1)
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.authz.user.email]
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function clear(req, res, next) {
  try {
    await db.query(
      `DELETE FROM notifications WHERE LOWER(target_email) = LOWER($1)`,
      [req.authz.user.email]
    );
    await addAuditLog({
      user: actor(req),
      action: 'Cleared Notifications',
      details: `Cleared notifications for ${req.authz.user.email}`,
      targetId: String(req.authz.user.id),
    });
    return res.json({ success: true, data: { cleared: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, clear };
