const Role = require('../models/Role');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function normalizeFlags(body = {}, existing = {}) {
  let is_it_admin =
    body.is_it_admin !== undefined ? Boolean(body.is_it_admin) : Boolean(existing.is_it_admin);
  let is_approver =
    body.is_approver !== undefined ? Boolean(body.is_approver) : Boolean(existing.is_approver);
  const is_executive =
    body.is_executive !== undefined ? Boolean(body.is_executive) : Boolean(existing.is_executive);

  if (is_it_admin && is_approver) {
    const err = new Error('A role cannot be both IT Admin and Approver. Choose only one.');
    err.status = 400;
    throw err;
  }

  return { is_it_admin, is_approver, is_executive };
}

/**
 * Reject enabling IT Admin / Approver if another role already has that flag.
 */
async function assertFlagAvailable(flags, excludeRoleId = null) {
  if (flags.is_it_admin) {
    const other = await Role.findRoleWithFlag('is_it_admin', excludeRoleId);
    if (other) {
      const err = new Error(
        `IT Admin is already enabled for role "${other.name}". It can only be enabled for one role. Uncheck it there first.`
      );
      err.status = 409;
      throw err;
    }
  }
  if (flags.is_approver) {
    const other = await Role.findRoleWithFlag('is_approver', excludeRoleId);
    if (other) {
      const err = new Error(
        `Approver is already enabled for role "${other.name}". It can only be enabled for one role. Uncheck it there first.`
      );
      err.status = 409;
      throw err;
    }
  }
}

async function assertSpecialRoleAssignable(role, { excludeUserId } = {}) {
  if (!role?.is_it_admin && !role?.is_approver) return;
  const count = await Role.countUsers(role.id, excludeUserId || null);
  if (count >= 1) {
    const kind = role.is_it_admin ? 'IT Admin' : 'Approver';
    const holders = await Role.getUsers(role.id);
    const holder = holders.find((u) => !excludeUserId || Number(u.id) !== Number(excludeUserId));
    const who = holder ? ` (currently: ${holder.name})` : '';
    const err = new Error(
      `${kind} role can only be assigned to one person${who}. Change that user's role first, then assign this role.`
    );
    err.status = 409;
    throw err;
  }
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
    await assertFlagAvailable(flags, null);

    const role = await Role.create({
      name,
      description,
      is_active,
      ...flags,
    });

    const fresh = await Role.findById(role.id);
    await addAuditLog({
      user: actor(req),
      action: 'Created Role',
      details: `Created role ${role.name}${flags.is_it_admin ? ' [IT Admin]' : ''}${flags.is_approver ? ' [Approver]' : ''}${flags.is_executive ? ' [Executive]' : ''}`,
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
        message: err.constraint?.includes('it_admin')
          ? 'IT Admin can only be enabled for one role.'
          : err.constraint?.includes('approver')
            ? 'Approver can only be enabled for one role.'
            : 'Role name already exists',
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
    const { name, description, is_active } = req.body;
    const flags = normalizeFlags(req.body, existing);

    const enablingItAdmin = flags.is_it_admin && !existing.is_it_admin;
    const enablingApprover = flags.is_approver && !existing.is_approver;

    if (enablingItAdmin || enablingApprover) {
      await assertFlagAvailable(
        {
          is_it_admin: enablingItAdmin,
          is_approver: enablingApprover,
        },
        existing.id
      );

      const count = await Role.countUsers(existing.id);
      if (count > 1) {
        return res.status(409).json({
          success: false,
          message:
            'This role already has multiple users. IT Admin / Approver roles may only have one assignee — reassign extra users first.',
        });
      }
    }

    const role = await Role.update(req.params.id, {
      name,
      description,
      is_active,
      ...flags,
    });

    await addAuditLog({
      user: actor(req),
      action: 'Updated Role',
      details: `Updated role ${role.name}${flags.is_it_admin ? ' [IT Admin]' : ''}${flags.is_approver ? ' [Approver]' : ''}${flags.is_executive ? ' [Executive]' : ''}`,
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
        message: err.constraint?.includes('it_admin')
          ? 'IT Admin can only be enabled for one role.'
          : err.constraint?.includes('approver')
            ? 'Approver can only be enabled for one role.'
            : 'Role name already exists',
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
  assertSpecialRoleAssignable,
};
