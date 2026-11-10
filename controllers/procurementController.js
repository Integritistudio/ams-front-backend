const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');
const inventoryService = require('../services/inventoryService');

const CONFIRMED = 'Purchase Confirmed';
const REQUEST_LINK_MESSAGE =
  'Purchases for an asset request are recorded with "Confirm Purchase" on the request (Pending Approvals). '
  + 'This form is only for ad-hoc procurement not linked to a request.';

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function isItAdmin(req) {
  return Boolean(req.authz?.role?.is_it_admin);
}

function requireItAdmin(req, res) {
  if (!isItAdmin(req)) {
    res.status(403).json({
      success: false,
      message: 'Only IT Admin can create or modify procurement logs',
    });
    return false;
  }
  return true;
}

async function findLog(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM procurement_logs WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM procurement_logs WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function maybeAddInventory(row, previousStatus) {
  const status = String(row.status || '');
  if (status !== 'Added') return;
  if (previousStatus === 'Added') return;
  await inventoryService.addStockByName(row.item_name, 1, 'Hardware');
}

async function list(req, res, next) {
  try {
    const result = await db.query(`SELECT * FROM procurement_logs ORDER BY created_at DESC`);
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
    if (!requireItAdmin(req, res)) return;

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
    if (source_req_id) {
      return res.status(400).json({ success: false, message: REQUEST_LINK_MESSAGE });
    }
    const linkedReqId = null;

    const pid = publicId('PROC');
    const initialStatus = status || 'In Progress';
    const result = await db.query(
      `INSERT INTO procurement_logs (
         public_id, source_req_id, item_name, vendor, cost, brand, serial_number,
         approval_date, delivery_date, approver, assigned_user_email, department,
         description, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        pid,
        linkedReqId,
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
        initialStatus,
      ]
    );

    const row = result.rows[0];
    await maybeAddInventory(row, null);

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
    if (!requireItAdmin(req, res)) return;

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

    if (existing.source_req_id || existing.status === CONFIRMED) {
      return res.status(409).json({
        success: false,
        message: 'This procurement log was created by Confirm Purchase on an asset request and cannot be edited.',
      });
    }
    if (source_req_id) {
      return res.status(400).json({ success: false, message: REQUEST_LINK_MESSAGE });
    }
    const linkedReqId = null;

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
        linkedReqId,
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

    const row = result.rows[0];
    await maybeAddInventory(row, existing.status);

    await addAuditLog({
      user: actor(req),
      action: 'Procurement Updated',
      details: `Updated procurement ${existing.public_id}`,
      targetId: existing.public_id,
    });

    return res.json({ success: true, data: row });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    if (!requireItAdmin(req, res)) return;

    const existing = await findLog(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Procurement log not found' });
    }
    if (existing.source_req_id || existing.status === CONFIRMED) {
      return res.status(409).json({
        success: false,
        message: 'This procurement log is linked to an asset request and inventory record; it cannot be deleted.',
      });
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
