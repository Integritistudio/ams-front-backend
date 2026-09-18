const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function findTemplate(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM email_templates WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM email_templates WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function list(req, res, next) {
  try {
    const result = await db.query(
      `SELECT * FROM email_templates ORDER BY name ASC`
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const template = await findTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    return res.json({ success: true, data: template });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name, subject, body, status } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({
        success: false,
        message: 'name, subject, and body are required',
      });
    }
    const pid = publicId('EML');
    const result = await db.query(
      `INSERT INTO email_templates (public_id, name, subject, body, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [pid, name, subject, body, status || 'Active']
    );
    const template = result.rows[0];
    await addAuditLog({
      user: actor(req),
      action: 'Created Email Template',
      details: `Created template ${template.name}`,
      targetId: template.public_id,
    });
    return res.status(201).json({ success: true, data: template });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await findTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const { name, subject, body, status } = req.body;
    const result = await db.query(
      `UPDATE email_templates SET
         name = COALESCE($2, name),
         subject = COALESCE($3, subject),
         body = COALESCE($4, body),
         status = COALESCE($5, status),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.id, name, subject, body, status]
    );
    await addAuditLog({
      user: actor(req),
      action: 'Updated Email Template',
      details: `Updated template ${result.rows[0].name}`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const existing = await findTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    await db.query(`DELETE FROM email_templates WHERE id = $1`, [existing.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Email Template',
      details: `Deleted template ${existing.name}`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, get, create, update, remove };
