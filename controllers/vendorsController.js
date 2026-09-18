const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function findVendor(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM vendors WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM vendors WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function list(req, res, next) {
  try {
    const result = await db.query(`SELECT * FROM vendors ORDER BY name ASC`);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const vendor = await findVendor(req.params.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    return res.json({ success: true, data: vendor });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name, category, contact, status, notes } = req.body;
    if (!name || !category) {
      return res.status(400).json({ success: false, message: 'name and category are required' });
    }
    const pid = publicId('VEN');
    const result = await db.query(
      `INSERT INTO vendors (public_id, name, category, contact, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [pid, name, category, contact || null, status || 'Active', notes || null]
    );
    const vendor = result.rows[0];
    await addAuditLog({
      user: actor(req),
      action: 'Vendor Saved',
      details: `Created vendor ${vendor.name}`,
      targetId: vendor.public_id,
    });
    return res.status(201).json({ success: true, data: vendor });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const vendor = await findVendor(req.params.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    const { name, category, contact, status, notes } = req.body;
    const result = await db.query(
      `UPDATE vendors SET
         name = COALESCE($2, name),
         category = COALESCE($3, category),
         contact = COALESCE($4, contact),
         status = COALESCE($5, status),
         notes = COALESCE($6, notes),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [vendor.id, name, category, contact, status, notes]
    );
    await addAuditLog({
      user: actor(req),
      action: 'Vendor Saved',
      details: `Updated vendor ${result.rows[0].name}`,
      targetId: vendor.public_id,
    });
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const vendor = await findVendor(req.params.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    await db.query(`DELETE FROM vendors WHERE id = $1`, [vendor.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Vendor Removed',
      details: `Removed vendor ${vendor.name}`,
      targetId: vendor.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, get, create, update, remove };
