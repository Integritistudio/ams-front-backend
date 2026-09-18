const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function findAsset(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM user_assets WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM user_assets WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function listMine(req, res, next) {
  try {
    const result = await db.query(
      `SELECT * FROM user_assets
       WHERE LOWER(user_email) = LOWER($1) OR user_id = $2
       ORDER BY assigned_date DESC NULLS LAST, created_at DESC`,
      [req.authz.user.email, req.authz.user.id]
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function listAll(req, res, next) {
  try {
    const { email, user_id } = req.query;
    const clauses = [];
    const params = [];
    let i = 1;
    if (email) {
      clauses.push(`LOWER(user_email) = LOWER($${i++})`);
      params.push(email);
    }
    if (user_id) {
      clauses.push(`user_id = $${i++}`);
      params.push(user_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT * FROM user_assets ${where}
       ORDER BY assigned_date DESC NULLS LAST, created_at DESC`,
      params
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const {
      user_id,
      user_email,
      asset_code,
      category,
      name,
      brand,
      serial_number,
      assigned_date,
      note,
      description,
    } = req.body;

    if (!user_email || !asset_code || !category || !name) {
      return res.status(400).json({
        success: false,
        message: 'user_email, asset_code, category, and name are required',
      });
    }

    let resolvedUserId = user_id || null;
    if (!resolvedUserId) {
      const u = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [
        user_email,
      ]);
      resolvedUserId = u.rows[0]?.id || null;
    }

    const pid = publicId('AST');
    const result = await db.query(
      `INSERT INTO user_assets (
         public_id, user_id, user_email, asset_code, category, name, brand,
         serial_number, assigned_date, note, description
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        pid,
        resolvedUserId,
        user_email.toLowerCase(),
        asset_code,
        category,
        name,
        brand || null,
        serial_number || null,
        assigned_date || new Date().toISOString().split('T')[0],
        note || null,
        description || null,
      ]
    );

    const asset = result.rows[0];
    await addAuditLog({
      user: actor(req),
      action: 'Assigned Asset',
      details: `Assigned ${asset.name} (${asset.asset_code}) to ${asset.user_email}`,
      targetId: asset.public_id,
    });

    return res.status(201).json({ success: true, data: asset });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await findAsset(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Asset not found' });
    }

    const {
      user_id,
      user_email,
      asset_code,
      category,
      name,
      brand,
      serial_number,
      assigned_date,
      note,
      description,
    } = req.body;

    const result = await db.query(
      `UPDATE user_assets SET
         user_id = COALESCE($2, user_id),
         user_email = COALESCE($3, user_email),
         asset_code = COALESCE($4, asset_code),
         category = COALESCE($5, category),
         name = COALESCE($6, name),
         brand = COALESCE($7, brand),
         serial_number = COALESCE($8, serial_number),
         assigned_date = COALESCE($9, assigned_date),
         note = COALESCE($10, note),
         description = COALESCE($11, description),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        existing.id,
        user_id,
        user_email ? user_email.toLowerCase() : null,
        asset_code,
        category,
        name,
        brand,
        serial_number,
        assigned_date,
        note,
        description,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Updated Asset',
      details: `Updated asset ${existing.public_id}`,
      targetId: existing.public_id,
    });

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const existing = await findAsset(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Asset not found' });
    }
    await db.query(`DELETE FROM user_assets WHERE id = $1`, [existing.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Asset',
      details: `Deleted asset ${existing.public_id}`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { listMine, listAll, create, update, remove };
