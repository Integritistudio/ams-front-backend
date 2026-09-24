const db = require('../config/database');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

const DEFAULTS = {
  id: 1,
  logo_url: null,
  color_primary: '#2563eb',
  color_accent: '#06b6d4',
};

async function get(req, res, next) {
  try {
    const result = await db.query(`SELECT * FROM portal_settings WHERE id = 1`);
    return res.json({ success: true, data: result.rows[0] || DEFAULTS });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const { logo_url, color_primary, color_accent } = req.body;

    await db.query(
      `INSERT INTO portal_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
    );

    const result = await db.query(
      `UPDATE portal_settings SET
         logo_url = CASE WHEN $1::boolean THEN $2 ELSE logo_url END,
         color_primary = COALESCE($3, color_primary),
         color_accent = COALESCE($4, color_accent),
         updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [
        logo_url !== undefined,
        logo_url !== undefined ? logo_url : null,
        color_primary || null,
        color_accent || null,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Updated Settings',
      details: 'Portal branding settings updated',
      targetId: '1',
    });

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

module.exports = { get, update };
