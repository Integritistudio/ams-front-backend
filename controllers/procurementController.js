const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function findLog(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM procurement_logs WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM procurement_logs WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function list(req, res, next) {
  try {
    const result = await db.query(
      `SELECT * FROM procurement_logs ORDER BY created_at DESC`
    );
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const row = await findLog(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Procurement log not found' });
    }
    return res.json({ success: true, data: row });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const {
      source_req_id,
      item_name,
      vendor,
      cost,
      brand,
      serial_number,
      approval_date,
      delivery_date,
      approver,
      assigned_user_email,
      department,
      description,
      status,
    } = req.body;

    if (!item_name) {
      return res.status(400).json({ success: false, message: 'item_name is required' });
    }

    const pid = publicId('PROC');
    const result = await db.query(
      `INSERT INTO procurement_logs (
         public_id, source_req_id, item_name, vendor, cost, brand, serial_number,
         approval_date, delivery_date, approver, assigned_user_email, department,
         description, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        pid,
        source_req_id || null,
        item_name,
        vendor || null,
        cost || null,
        brand || null,
        serial_number || null,
        approval_date || null,
        delivery_date || null,
        approver || null,
        assigned_user_email ? assigned_user_email.toLowerCase() : null,
        department || null,
        description || null,
        status || 'Delivered / Fulfilled',
      ]
    );

    const row = result.rows[0];

    if (source_req_id) {
      await db.query(
        `UPDATE requisitions SET
           status = 'Fulfilled',
           fulfillment_details = $2,
           updated_at = NOW()
         WHERE id = $1`,
        [source_req_id, JSON.stringify(row)]
      );
    }

    await addAuditLog({
      user: actor(req),
      action: 'Procurement Logged',
      details: `Logged procurement ${row.public_id} for ${item_name}`,
      targetId: row.public_id,
    });

    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await findLog(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Procurement log not found' });
    }

    const {
      item_name,
      vendor,
      cost,
      brand,
      serial_number,
      approval_date,
      delivery_date,
      approver,
      assigned_user_email,
      department,
      description,
      status,
      source_req_id,
    } = req.body;

    const result = await db.query(
      `UPDATE procurement_logs SET
         source_req_id = COALESCE($2, source_req_id),
         item_name = COALESCE($3, item_name),
         vendor = COALESCE($4, vendor),
         cost = COALESCE($5, cost),
         brand = COALESCE($6, brand),
         serial_number = COALESCE($7, serial_number),
         approval_date = COALESCE($8, approval_date),
         delivery_date = COALESCE($9, delivery_date),
         approver = COALESCE($10, approver),
         assigned_user_email = COALESCE($11, assigned_user_email),
         department = COALESCE($12, department),
         description = COALESCE($13, description),
         status = COALESCE($14, status),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        existing.id,
        source_req_id,
        item_name,
        vendor,
        cost,
        brand,
        serial_number,
        approval_date,
        delivery_date,
        approver,
        assigned_user_email ? assigned_user_email.toLowerCase() : null,
        department,
        description,
        status,
      ]
    );

    await addAuditLog({
      user: actor(req),
      action: 'Procurement Updated',
      details: `Updated procurement ${existing.public_id}`,
      targetId: existing.public_id,
    });

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const existing = await findLog(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Procurement log not found' });
    }
    await db.query(`DELETE FROM procurement_logs WHERE id = $1`, [existing.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Procurement Deleted',
      details: `Deleted procurement ${existing.public_id}`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, get, create, update, remove };
