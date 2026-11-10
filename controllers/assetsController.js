const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');
const { assetDetails, assetVars } = require('../services/emailDetails');
const inventoryService = require('../services/inventoryService');
const fulfil = require('../services/fulfillmentRules');

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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

/** Next incremental code: AST-1, AST-2, … */
async function nextAssetCode() {
  const result = await db.query(`
    SELECT COALESCE(MAX(
      CASE
        WHEN asset_code ~ '^AST-[0-9]+$'
          THEN CAST(SUBSTRING(asset_code FROM 5) AS INTEGER)
        ELSE 0
      END
    ), 0) + 1 AS n
    FROM user_assets
  `);
  return `AST-${result.rows[0].n}`;
}

async function getNextCode(req, res, next) {
  try {
    const code = await nextAssetCode();
    return res.json({ success: true, data: { asset_code: code } });
  } catch (err) {
    return next(err);
  }
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

async function findRequest(client, key) {
  if (!key) return null;
  const k = String(key);
  const result = await client.query(
    /^\d+$/.test(k)
      ? `SELECT * FROM requisitions WHERE id = $1 FOR UPDATE`
      : `SELECT * FROM requisitions WHERE public_id = $1 FOR UPDATE`,
    [k]
  );
  return result.rows[0] || null;
}

/**
 * Assign an asset / license seat to a user. Requirements: the item must be registered in inventory
 * before assignment, and assigning from inventory updates the stock. So every assignment takes one
 * unit/seat from an inventory item; when linked to an asset request, the request must be approved
 * (and, for a purchase, purchase-confirmed) and not yet fully assigned.
 */
async function create(req, res, next) {
  let client;
  try {
    const {
      user_id,
      user_email,
      name,
      brand,
      serial_number,
      assigned_date,
      note,
      description,
      source_req_id,
      source_req_public_id,
      inventory_item_id,
    } = req.body;

    if (!user_email) {
      return res.status(400).json({ success: false, message: 'user_email is required' });
    }
    if (!inventory_item_id) {
      return res.status(400).json({
        success: false,
        message: 'inventory_item_id is required: the item must be registered in inventory before assignment.',
      });
    }

    let resolvedUserId = user_id || null;
    if (!resolvedUserId) {
      const u = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [user_email]);
      resolvedUserId = u.rows[0]?.id || null;
    }

    const code = await nextAssetCode();
    client = await db.getClient();
    await client.query('BEGIN');

    const item = await inventoryService.getInventory(inventory_item_id, client);
    if (!item) throw httpError('Inventory item not found');

    const request = await findRequest(client, source_req_id || source_req_public_id);
    if ((source_req_id || source_req_public_id) && !request) throw httpError('Linked asset request not found');
    if (request) {
      const linked = await client.query(
        `SELECT COUNT(*)::int AS c FROM user_assets WHERE source_req_id = $1 OR source_req_public_id = $2`,
        [request.id, request.public_id]
      );
      const check = fulfil.checkAssignToRequest(request, linked.rows[0].c);
      if (!check.ok) throw httpError(check.message, check.status);
      if (inventoryService.inventoryTypeFor(request.type) !== item.type) {
        throw httpError(`Request ${request.public_id} is ${request.type}, but "${item.name}" is ${item.type} inventory.`);
      }
      if (request.inventory_item_id && Number(request.inventory_item_id) !== Number(item.id)) {
        throw httpError(`Request ${request.public_id} was purchased into inventory item ${request.inventory_item_id}; assign from that item.`);
      }
    }

    const after = await inventoryService.takeOne(client, item.id);
    const result = await client.query(
      `INSERT INTO user_assets (
         public_id, user_id, user_email, asset_code, category, name, brand,
         serial_number, assigned_date, note, description, source_req_id, source_req_public_id,
         inventory_item_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        publicId('AST'),
        resolvedUserId,
        user_email.toLowerCase(),
        code,
        inventoryService.assetCategoryFor(item.type),
        String(name || '').trim() || item.name,
        brand || null,
        serial_number || null,
        assigned_date || new Date().toISOString().split('T')[0],
        note || null,
        description || null,
        request ? request.id : null,
        request ? request.public_id : null,
        item.id,
      ]
    );
    const asset = result.rows[0];

    if (request) {
      await client.query(
        `UPDATE requisitions SET
           linked_asset_ids = COALESCE(linked_asset_ids, '[]'::jsonb) || $2::jsonb,
           updated_at = NOW()
         WHERE id = $1`,
        [request.id, JSON.stringify([asset.id])]
      );
    }
    await client.query('COMMIT');
    client.release();
    client = null;
    const linkedReqPublic = request ? request.public_id : null;

    await addAuditLog({
      user: actor(req),
      action: 'Assigned Asset',
      details: `Assigned ${asset.name} (${asset.asset_code}) to ${asset.user_email} from inventory ${item.public_id} (available ${item.quantity_available} → ${after.quantity_available})${
        linkedReqPublic ? `; linked to ${linkedReqPublic}` : ''
      }`,
      targetId: asset.public_id,
    });

    await notifyUser({
      targetEmail: asset.user_email,
      subject: `Asset assigned: ${asset.name}`,
      title: 'Asset assigned to you',
      text: `IT assigned asset "${asset.name}" (${asset.asset_code}) to your account.${asset.note ? ` Note: ${asset.note}` : ''}${
        linkedReqPublic ? ` Linked to request ${linkedReqPublic}.` : ' Not linked to any request.'
      }`,
      type: 'success',
      ctaLabel: 'View my assets',
      ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/my-assets`,
      details: assetDetails(asset, { assignedBy: req.authz.user.name }),
      event: 'asset.assigned',
      vars: assetVars(asset, { assignedBy: req.authz.user.name }),
    });

    return res.status(201).json({ success: true, data: asset });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
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
    // Category follows the inventory item's type for inventory-backed assets.
    const categoryUpdate = existing.inventory_item_id ? undefined : category;

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
        categoryUpdate,
        name,
        brand,
        serial_number,
        assigned_date,
        note,
        description,
      ]
    );

    const updated = result.rows[0];
    await addAuditLog({
      user: actor(req),
      action: 'Updated Asset',
      details: `Updated asset ${existing.public_id}`,
      targetId: existing.public_id,
    });

    if (
      user_email &&
      String(user_email).toLowerCase() !== String(existing.user_email || '').toLowerCase()
    ) {
      await notifyUser({
        targetEmail: user_email,
        subject: `Asset assigned: ${updated.name}`,
        title: 'Asset assigned to you',
        text: `IT assigned asset "${updated.name}" (${updated.asset_code}) to your account.`,
        type: 'success',
        ctaLabel: 'View my assets',
        ctaUrl: `${(process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '')}/my-assets`,
        details: assetDetails(updated, { assignedBy: req.authz.user.name }),
      event: 'asset.assigned',
      vars: assetVars(updated, { assignedBy: req.authz.user.name  }),
    });
    }

    return res.json({ success: true, data: updated });
  } catch (err) {
    return next(err);
  }
}

/** Removing an assignment returns the unit / seat to its inventory item. */
async function remove(req, res, next) {
  let client;
  try {
    const existing = await findAsset(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Asset not found' });
    }
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_assets WHERE id = $1`, [existing.id]);
    if (existing.source_req_id) {
      await client.query(
        `UPDATE requisitions SET
           linked_asset_ids = (
             SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(linked_asset_ids, '[]'::jsonb)) e
             WHERE e <> to_jsonb($2::int)
           ),
           updated_at = NOW()
         WHERE id = $1`,
        [existing.source_req_id, existing.id]
      );
    }
    const item = existing.inventory_item_id
      ? await inventoryService.returnOne(client, existing.inventory_item_id)
      : null;
    await client.query('COMMIT');
    client.release();
    client = null;
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Asset',
      details: `Removed assignment ${existing.asset_code} (${existing.name}) from ${existing.user_email}${
        item ? `; returned to inventory ${item.public_id} (available now ${item.quantity_available})` : ''
      }`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    return next(err);
  }
}

module.exports = { listMine, listAll, create, update, remove, getNextCode };
