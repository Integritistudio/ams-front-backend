const Role = require('../models/Role');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function list(req, res, next) {
  try {
    const roles = await Role.findAll();
    return res.json({ success: true, data: roles });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    return res.json({ success: true, data: role });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name, description, is_active } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const role = await Role.create({ name, description, is_active });
    await addAuditLog({
      user: actor(req),
      action: 'Created Role',
      details: `Created role ${role.name}`,
      targetId: String(role.id),
    });
    return res.status(201).json({ success: true, data: role });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Role name already exists' });
    }
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await Role.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    const { name, description, is_active } = req.body;
    const role = await Role.update(req.params.id, { name, description, is_active });
    await addAuditLog({
      user: actor(req),
      action: 'Updated Role',
      details: `Updated role ${role.name}`,
      targetId: String(role.id),
    });
    return res.json({ success: true, data: role });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Role name already exists' });
    }
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    await Role.remove(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Role',
      details: `Deleted role ${role.name}`,
      targetId: String(role.id),
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

async function getUsers(req, res, next) {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    const users = await Role.getUsers(req.params.id);
    return res.json({ success: true, data: users });
  } catch (err) {
    return next(err);
  }
}

async function getPermissions(req, res, next) {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    const permissions = await Role.getPermissions(req.params.id);
    return res.json({ success: true, data: permissions });
  } catch (err) {
    return next(err);
  }
}

async function setPermissions(req, res, next) {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ success: false, message: 'permissions must be an array' });
    }
    await Role.setPermissions(req.params.id, permissions);
    const updated = await Role.getPermissions(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Updated Role Permissions',
      details: `Updated permissions for role ${role.name}`,
      targetId: String(role.id),
    });
    return res.json({ success: true, data: updated });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  getUsers,
  getPermissions,
  setPermissions,
};
