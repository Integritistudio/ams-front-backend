const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');
const inventoryService = require('../services/inventoryService');
const { REQ_STATUS } = require('../services/workflowConstants');

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

async function markLinkedInProcurement(linkedReqId) {
  if (!linkedReqId) return;
  await db.query(
    `UPDATE requisitions SET
       status = $2,
       current_stage = $2,
       updated_at = NOW()
     WHERE id = $1
       AND status = ANY($3::text[])`,
    [
      linkedReqId,
      REQ_STATUS.IN_PROCUREMENT,
      [
        REQ_STATUS.SENT_TO_IT,
        REQ_STATUS.IN_PROGRESS,
        REQ_STATUS.ON_HOLD,
        REQ_STATUS.IN_PROCUREMENT,
      ],
    ]
  );
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

    let linkedReqId = source_req_id || null;
    if (linkedReqId && !/^\d+$/.test(String(linkedReqId))) {
      const reqLookup = await db.query(`SELECT id FROM requisitions WHERE public_id = $1`, [
        String(linkedReqId),
      ]);
      linkedReqId = reqLookup.rows[0]?.id || null;
      if (!linkedReqId) {
        return res.status(400).json({ success: false, message: 'Invalid source asset request' });
      }
    }

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
    await markLinkedInProcurement(linkedReqId);

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

    let linkedReqId = source_req_id;
    if (linkedReqId != null && linkedReqId !== '' && !/^\d+$/.test(String(linkedReqId))) {
      const reqLookup = await db.query(`SELECT id FROM requisitions WHERE public_id = $1`, [
        String(linkedReqId),
      ]);
      linkedReqId = reqLookup.rows[0]?.id || null;
    }

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
    if (row.source_req_id) {
      await markLinkedInProcurement(row.source_req_id);
    }

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
