const db = require('../config/database');
const { publicId } = require('./auditService');

async function listInventory({ activeOnly = false } = {}) {
  const result = await db.query(
    `SELECT i.*, c.name AS catalog_name
     FROM inventory_items i
     LEFT JOIN catalog_items c ON c.id = i.catalog_item_id
     ${activeOnly ? 'WHERE i.is_active = TRUE' : ''}
     ORDER BY i.name ASC`
  );
  return result.rows;
}

async function getInventory(id) {
  const result = await db.query(`SELECT * FROM inventory_items WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

/** True if any active inventory row matches item name (case-insensitive) with qty > 0 */
async function isItemAvailable(itemName) {
  if (!itemName) return false;
  const result = await db.query(
    `SELECT COALESCE(SUM(quantity_available - quantity_reserved), 0)::int AS available
     FROM inventory_items
     WHERE is_active = TRUE
       AND LOWER(TRIM(name)) = LOWER(TRIM($1))`,
    [itemName]
  );
  return Number(result.rows[0]?.available || 0) > 0;
}

async function createInventory(body) {
  const qty = Math.max(0, Number(body.quantity_available) || 0);
  const result = await db.query(
    `INSERT INTO inventory_items (
       public_id, catalog_item_id, name, type, quantity_available, quantity_reserved,
       unit, location, notes, is_active
     ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,COALESCE($9, TRUE))
     RETURNING *`,
    [
      publicId('INV'),
      body.catalog_item_id || null,
      body.name,
      body.type || 'Hardware',
      qty,
      body.unit || 'unit',
      body.location || null,
      body.notes || null,
      body.is_active,
    ]
  );
  return result.rows[0];
}

async function updateInventory(id, body) {
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
     WHERE id = $1 RETURNING *`,
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
  return result.rows[0] || null;
}

async function removeInventory(id) {
  await db.query(`DELETE FROM inventory_items WHERE id = $1`, [id]);
}

/** Increase stock when procurement marks Added */
async function addStockByName(itemName, qty = 1, type = 'Hardware') {
  const amount = Math.max(1, Number(qty) || 1);
  const existing = await db.query(
    `SELECT id FROM inventory_items
     WHERE is_active = TRUE AND LOWER(TRIM(name)) = LOWER(TRIM($1))
     ORDER BY id ASC LIMIT 1`,
    [itemName]
  );
  if (existing.rows[0]) {
    const result = await db.query(
      `UPDATE inventory_items
       SET quantity_available = quantity_available + $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.rows[0].id, amount]
    );
    return result.rows[0];
  }
  return createInventory({
    name: itemName,
    type,
    quantity_available: amount,
  });
}

module.exports = {
  listInventory,
  getInventory,
  isItemAvailable,
  createInventory,
  updateInventory,
  removeInventory,
  addStockByName,
};
