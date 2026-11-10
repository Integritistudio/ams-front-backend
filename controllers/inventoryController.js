const inventoryService = require('../services/inventoryService');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function requireItAdmin(req, res) {
  if (!req.authz?.role?.is_it_admin) {
    res.status(403).json({ success: false, message: 'Only IT Admin can manage inventory' });
    return false;
  }
  return true;
}

async function list(req, res, next) {
  try {
    const rows = await inventoryService.listInventory({
      activeOnly: req.query.active === '1',
    });
    return res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const row = await inventoryService.getInventory(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Inventory item not found' });
    return res.json({ success: true, data: row });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    if (!requireItAdmin(req, res)) return;
    if (!req.body?.name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const row = await inventoryService.createInventory(req.body);
    await addAuditLog({
      user: actor(req),
      action: 'Created Inventory Item',
      details: `${row.name} qty=${row.quantity_available}`,
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
    const before = await inventoryService.getInventory(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Inventory item not found' });
    const row = await inventoryService.updateInventory(req.params.id, req.body || {});
    const qtyChange =
      Number(before.quantity_available) !== Number(row.quantity_available)
        ? ` — available ${before.quantity_available} → ${row.quantity_available} (manual stock adjustment)`
        : '';
    await addAuditLog({
      user: actor(req),
      action: qtyChange ? 'Inventory Stock Adjusted' : 'Updated Inventory Item',
      details: `${row.name}${qtyChange}`,
      targetId: row.public_id,
    });
    return res.json({ success: true, data: row });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    if (!requireItAdmin(req, res)) return;
    const item = await inventoryService.removeInventory(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Inventory Item',
      details: `${item.name} (${item.type})`,
      targetId: item.public_id,
    });
    return res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    return next(err);
  }
}

module.exports = { list, get, create, update, remove };
