const db = require('../config/database');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function list(req, res, next) {
  try {
    const result = await db.query(
      `SELECT * FROM departments WHERE is_active = TRUE ORDER BY name ASC`
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const result = await db.query(
      `INSERT INTO departments (name) VALUES ($1) RETURNING *`,
      [String(name).trim()]
    );
    const dept = result.rows[0];
    await addAuditLog({
      user: actor(req),
      action: 'Created Department',
      details: `Created department ${dept.name}`,
      targetId: String(dept.id),
    });
    return res.status(201).json({ success: true, data: dept });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Department already exists' });
    }
    return next(err);
  }
}

module.exports = { list, create };
