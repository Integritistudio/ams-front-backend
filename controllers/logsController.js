const db = require('../config/database');
const { canViewAll } = require('../middleware/permissions');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function list(req, res, next) {
  try {
    let result;
    if (canViewAll('logs')(req)) {
      result = await db.query(
        `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250`
      );
    } else {
      result = await db.query(
        `SELECT * FROM audit_logs
         WHERE LOWER(user_email) = LOWER($1)
         ORDER BY created_at DESC
         LIMIT 250`,
        [req.authz.user.email]
      );
    }
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function clear(req, res, next) {
  try {
    if (canViewAll('logs')(req)) {
      await db.query(`DELETE FROM audit_logs`);
    } else {
      await db.query(`DELETE FROM audit_logs WHERE LOWER(user_email) = LOWER($1)`, [
        req.authz.user.email,
      ]);
    }
    await addAuditLog({
      user: actor(req),
      action: 'Cleared Audit Logs',
      details: canViewAll('logs')(req)
        ? 'Cleared all audit logs'
        : `Cleared own audit logs for ${req.authz.user.email}`,
      targetId: 'N/A',
    });
    return res.json({ success: true, data: { cleared: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, clear };
