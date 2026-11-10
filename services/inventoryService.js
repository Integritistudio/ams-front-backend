const db = require('../config/database');
const { publicId } = require('./auditService');

/**
 * Inventory items hold stock per item (hardware units or software license seats):
 *   quantity_available = units / seats still free to assign
 *   quantity_assigned  = units / seats currently assigned (count of linked user_assets)
 * Stock only grows through Confirm Purchase (or manual stock entry by Admin/IT) and only shrinks
 * when an asset / seat is assigned; unassigning returns it.
 */

const INVENTORY_SELECT = `
  SELECT i.*, c.name AS catalog_name,
         (SELECT COUNT(*)::int FROM user_assets ua WHERE ua.inventory_item_id = i.id) AS quantity_assigned
  FROM inventory_items i
  LEFT JOIN catalog_items c ON c.id = i.catalog_item_id
`;

function q(client) {
  return client || db;
}

function validationError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Inventory type for an asset request type ('Hardware' | 'Software'). */
function inventoryTypeFor(requestType) {
  return String(requestType || '').toLowerCase().startsWith('soft') ? 'Software' : 'Hardware';
}

/** Asset category used on Assign Assets for an inventory type. */
function assetCategoryFor(inventoryType) {
  return inventoryType === 'Software' ? 'Software License' : 'Hardware';
}

async function listInventory({ activeOnly = false } = {}) {
  const result = await db.query(
    `${INVENTORY_SELECT} ${activeOnly ? 'WHERE i.is_active = TRUE' : ''} ORDER BY i.name ASC`
  );
  return result.rows;
}

/** Accepts the numeric id or the public id (INV-…), as the Inventory page uses public ids. */
async function getInventory(id, client) {
  if (id === undefined || id === null || id === '') return null;
  const key = String(id);
  const result = /^\d+$/.test(key)
    ? await q(client).query(`${INVENTORY_SELECT} WHERE i.id = $1`, [key])
    : await q(client).query(`${INVENTORY_SELECT} WHERE i.public_id = $1`, [key]);
  return result.rows[0] || null;
}

/**
 * Indicative availability for a request (requirements: "the system checks the hardware inventory and
 * displays indicative availability information"; Admin/IT still verifies manually).
 * Matches active items of the same type by exact name (case/space-insensitive).
 */
async function indicativeStock(itemName, type) {
  if (!itemName) return { available: 0, items: [] };
  const result = await db.query(
    `${INVENTORY_SELECT}
     WHERE i.is_active = TRUE
       AND i.type = $2
       AND LOWER(TRIM(i.name)) = LOWER(TRIM($1))
     ORDER BY i.id ASC`,
    [itemName, type]
  );
  const items = result.rows.map((r) => ({
    id: r.id,
    public_id: r.public_id,
    name: r.name,
    type: r.type,
    location: r.location,
    available: Math.max(0, Number(r.quantity_available) - Number(r.quantity_reserved || 0)),
    assigned: Number(r.quantity_assigned || 0),
  }));
  return { available: items.reduce((sum, i) => sum + i.available, 0), items };
}

async function createInventory(body, client) {
  const qty = Math.max(0, Number(body.quantity_available) || 0);
  const result = await q(client).query(
    `INSERT INTO inventory_items (
       public_id, catalog_item_id, name, type, quantity_available, quantity_reserved,
       unit, location, notes, is_active
     ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,COALESCE($9, TRUE))
     RETURNING id`,
    [
      publicId('INV'),
      body.catalog_item_id || null,
      body.name,
      body.type || 'Hardware',
      qty,
      body.unit || (body.type === 'Software' ? 'seat' : 'unit'),
      body.location || null,
      body.notes || null,
      body.is_active,
    ]
  );
  return getInventory(result.rows[0].id, client);
}

async function updateInventory(id, body) {
  if (body.quantity_available !== undefined && !(Number(body.quantity_available) >= 0)) {
    throw validationError('quantity_available must be 0 or more');
  }
  const existing = await getInventory(id);
  if (!existing) return null;
  id = existing.id;
  const result = await db.query(
    `UPDATE inventory_items SET
       name = COALESCE($2, name),
       type = COALESCE($3, type),
       catalog_item_id = COALESCE($4, catalog_item_id),
       quantity_available = COALESCE($5, quantity_available),
       quantity_reserved = COALESCE($6, quantity_reserved),
       unit = COALESCE($7, unit),
       location = COALESCE($8, location),
       notes = COALESCE($9, notes),
       is_active = COALESCE($10, is_active),
       updated_at = NOW()
     WHERE id = $1 RETURNING id`,
    [
      id,
      body.name,
      body.type,
      body.catalog_item_id,
      body.quantity_available !== undefined ? Number(body.quantity_available) : null,
      body.quantity_reserved !== undefined ? Number(body.quantity_reserved) : null,
      body.unit,
      body.location,
      body.notes,
      body.is_active,
    ]
  );
  return result.rows[0] ? getInventory(id) : null;
}

/** Items with assigned assets / seats, or a procurement history, cannot be deleted — deactivate them. */
async function removeInventory(id) {
  const item = await getInventory(id);
  if (!item) throw validationError('Inventory item not found', 404);
  id = item.id;
  const linked = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM user_assets WHERE inventory_item_id = $1) AS assets,
       (SELECT COUNT(*)::int FROM procurement_logs WHERE inventory_item_id = $1) AS logs`,
    [id]
  );
  const { assets, logs } = linked.rows[0];
  if (assets || logs) {
    throw validationError(
      `This item has ${assets} assigned asset(s) and ${logs} procurement record(s). Deactivate it instead of deleting.`,
      409
    );
  }
  await db.query(`DELETE FROM inventory_items WHERE id = $1`, [id]);
  return item;
}

/**
 * Add `qty` units/seats (Confirm Purchase). Uses `inventoryItemId` when given, otherwise the first
 * active item of the same name and type, otherwise creates one. Returns the updated item.
 */
async function addStock(client, { inventoryItemId = null, name, type = 'Hardware', qty = 1, location = null }) {
  const amount = Math.max(1, Math.floor(Number(qty)) || 1);
  let targetId = inventoryItemId ? Number(inventoryItemId) : null;

  if (targetId) {
    const found = await q(client).query(
      `SELECT id, type FROM inventory_items WHERE id = $1 AND is_active = TRUE FOR UPDATE`,
      [targetId]
    );
    if (!found.rows[0]) throw validationError('Inventory item not found or inactive');
    if (found.rows[0].type !== type) {
      throw validationError(`Inventory item is ${found.rows[0].type}, but this request is ${type}.`);
    }
  } else {
    const existing = await q(client).query(
      `SELECT id FROM inventory_items
       WHERE is_active = TRUE AND type = $2 AND LOWER(TRIM(name)) = LOWER(TRIM($1))
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [name, type]
    );
    targetId = existing.rows[0]?.id || null;
  }

  if (!targetId) {
    return createInventory({ name, type, quantity_available: amount, location }, client);
  }
  await q(client).query(
    `UPDATE inventory_items SET quantity_available = quantity_available + $2, updated_at = NOW() WHERE id = $1`,
    [targetId, amount]
  );
  return getInventory(targetId, client);
}

/** Take one unit/seat for an assignment. Throws 409 when nothing is free. */
async function takeOne(client, inventoryItemId) {
  const result = await q(client).query(
    `UPDATE inventory_items
     SET quantity_available = quantity_available - 1, updated_at = NOW()
     WHERE id = $1 AND is_active = TRUE AND quantity_available - quantity_reserved >= 1
     RETURNING id`,
    [inventoryItemId]
  );
  if (!result.rows[0]) {
    const item = await getInventory(inventoryItemId, client);
    if (!item) throw validationError('Inventory item not found');
    if (!item.is_active) throw validationError(`Inventory item "${item.name}" is inactive.`, 409);
    throw validationError(`No stock left for "${item.name}". Confirm a purchase or add stock first.`, 409);
  }
  return getInventory(inventoryItemId, client);
}

/** Return one unit/seat when an assignment is removed. */
async function returnOne(client, inventoryItemId) {
  await q(client).query(
    `UPDATE inventory_items SET quantity_available = quantity_available + 1, updated_at = NOW() WHERE id = $1`,
    [inventoryItemId]
  );
  return getInventory(inventoryItemId, client);
}

/** Legacy ad-hoc procurement "Added" status: +1 of the named item. */
async function addStockByName(itemName, qty = 1, type = 'Hardware') {
  return addStock(null, { name: itemName, type, qty });
}

module.exports = {
  inventoryTypeFor,
  assetCategoryFor,
  listInventory,
  getInventory,
  indicativeStock,
  createInventory,
  updateInventory,
  removeInventory,
  addStock,
  takeOne,
  returnOne,
  addStockByName,
};
