const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');

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

    // Resolve source_req_id from public_id if needed
    let linkedReqId = source_req_id || null;
    if (linkedReqId && !/^\d+$/.test(String(linkedReqId))) {
      const reqLookup = await db.query(
        `SELECT id FROM requisitions WHERE public_id = $1`,
        [String(linkedReqId)]
      );
      linkedReqId = reqLookup.rows[0]?.id || null;
      if (!linkedReqId) {
        return res.status(400).json({ success: false, message: 'Invalid source asset request' });
      }
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
        status || 'Delivered / Fulfilled',
      ]
    );

    const row = result.rows[0];

    if (linkedReqId) {
      const reqRes = await db.query(
        `SELECT public_id, item, requester_name, requester_email, approver_id
         FROM requisitions WHERE id = $1`,
        [linkedReqId]
      );
      const linked = reqRes.rows[0];

      await db.query(
        `UPDATE requisitions SET
           status = 'Completed',
           fulfillment_details = $2,
           updated_at = NOW()
         WHERE id = $1`,
        [linkedReqId, JSON.stringify(row)]
      );

      const portal = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
      if (linked?.requester_email) {
        await notifyUser({
          targetEmail: linked.requester_email,
          subject: `Completed Requisition ${linked.public_id}`,
          title: 'Asset request completed',
          text: `Your asset request ${linked.public_id} for "${linked.item || item_name}" has been completed via procurement delivery.`,
          type: 'success',
          ctaLabel: 'View requisition',
          ctaUrl: `${portal}/requisitions`,
          name: linked.requester_name,
        });
      }
      if (linked?.approver_id) {
        const approverRes = await db.query(
          `SELECT email, name FROM users WHERE id = $1 AND status = 'Active' LIMIT 1`,
          [linked.approver_id]
        );
        const signer = approverRes.rows[0];
        if (
          signer?.email &&
          (signer.email || '').toLowerCase() !== (linked.requester_email || '').toLowerCase()
        ) {
          await notifyUser({
            targetEmail: signer.email,
            subject: `Completed Requisition ${linked.public_id}`,
            title: 'Asset request completed',
            text: `Asset request ${linked.public_id} for "${linked.item || item_name}" (requested by ${linked.requester_name}) has been marked Completed by IT.`,
            type: 'success',
            ctaLabel: 'View asset requests',
            ctaUrl: `${portal}/requisitions`,
            name: signer.name,
          });
        }
      }
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
      const reqLookup = await db.query(
        `SELECT id FROM requisitions WHERE public_id = $1`,
        [String(linkedReqId)]
      );
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
