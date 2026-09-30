const Role = require('../models/Role');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

const ROLE_FLAGS = [
  'is_it_admin',
  'is_hr_manager',
  'is_finance_manager',
  'is_gm',
  'is_executive',
];

const FLAG_LABELS = {
  is_it_admin: 'IT Admin',
  is_hr_manager: 'HR Manager',
  is_finance_manager: 'Finance Manager',
  is_gm: 'GM',
  is_executive: 'Executive',
};

function normalizeFlags(body = {}, existing = {}) {
  return {
    is_it_admin:
      body.is_it_admin !== undefined ? Boolean(body.is_it_admin) : Boolean(existing.is_it_admin),
    is_executive:
      body.is_executive !== undefined ? Boolean(body.is_executive) : Boolean(existing.is_executive),
    is_hr_manager:
      body.is_hr_manager !== undefined
        ? Boolean(body.is_hr_manager)
        : Boolean(existing.is_hr_manager),
    is_finance_manager:
      body.is_finance_manager !== undefined
        ? Boolean(body.is_finance_manager)
        : Boolean(existing.is_finance_manager),
    is_gm: body.is_gm !== undefined ? Boolean(body.is_gm) : Boolean(existing.is_gm),
    // Approver role removed — always persist false
    is_approver: false,
  };
}

function flagAuditSuffix(flags) {
  return ROLE_FLAGS.filter((k) => flags[k])
    .map((k) => ` [${FLAG_LABELS[k]}]`)
    .join('');
}

async function assertSpecialRoleAssignable() {
  return;
}

function uniqueConstraintMessage() {
  return 'Role name already exists';
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
    const flags = normalizeFlags(req.body);
    const isSuperAdmin = Boolean(req.authz?.is_super_admin || req.authz?.user?.is_super_admin);
    const can_export = isSuperAdmin ? Boolean(req.body.can_export) : false;

    const role = await Role.create({
      name,
      description,
      is_active,
      ...flags,
      can_export,
    });

    const fresh = await Role.findById(role.id);
    await addAuditLog({
      user: actor(req),
      action: 'Created Role',
      details: `Created role ${role.name}${flagAuditSuffix(flags)}${can_export ? ' [Export]' : ''}`,
      targetId: String(role.id),
    });
    return res.status(201).json({ success: true, data: fresh || role });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: uniqueConstraintMessage(err),
      });
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
    if (existing.is_super_admin_role) {
      return res.status(403).json({
        success: false,
        message: 'Super Admin role cannot be edited.',
      });
    }
    const { name, description, is_active } = req.body;
    const flags = normalizeFlags(req.body, existing);
    const isSuperAdmin = Boolean(req.authz?.is_super_admin || req.authz?.user?.is_super_admin);
    const payload = {
      name,
      description,
      is_active,
      ...flags,
    };
    if (isSuperAdmin && req.body.can_export !== undefined) {
      payload.can_export = Boolean(req.body.can_export);
    }

    const role = await Role.update(req.params.id, payload);

    await addAuditLog({
      user: actor(req),
      action: 'Updated Role',
      details: `Updated role ${role.name}${flagAuditSuffix(flags)}${role.can_export ? ' [Export]' : ''}`,
      targetId: String(role.id),
    });
    return res.json({ success: true, data: role });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: uniqueConstraintMessage(err),
      });
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
    if (role.is_super_admin_role) {
      return res.status(403).json({
        success: false,
        message: 'Super Admin role cannot be deleted.',
      });
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
    if (role.is_super_admin_role) {
      return res.status(403).json({
        success: false,
        message: 'Super Admin role cannot be edited.',
      });
    }
    let { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ success: false, message: 'permissions must be an array' });
    }
    // Non–Super Admin roles cannot receive settings / email_settings
    if (!role.is_super_admin_role) {
      permissions = permissions.map((p) => {
        const slug = p.slug;
        if (slug === 'settings' || slug === 'email_settings') {
          return { ...p, allowed: false };
        }
        return p;
      });
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
  assertSpecialRoleAssignable,
};
