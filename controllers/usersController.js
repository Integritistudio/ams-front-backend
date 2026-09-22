const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Role = require('../models/Role');
const authService = require('../services/authService');
const { addAuditLog } = require('../services/auditService');
const { assertSpecialRoleAssignable } = require('./rolesController');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function sanitize(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

async function list(req, res, next) {
  try {
    const { search, roleId, role_id, department, status } = req.query;
    const users = await User.findAll({
      search,
      roleId: roleId || role_id,
      department,
      status,
    });
    return res.json({ success: true, data: users.map(sanitize) });
  } catch (err) {
    return next(err);
  }
}

async function directory(req, res, next) {
  try {
    const perms = req.authz?.permissions || [];
    const allowed = ['tickets', 'requisitions', 'approvals', 'assign_assets', 'procurement_log', 'users'].some((p) =>
      perms.includes(p)
    );
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const users = await User.findAll({ status: 'Active' });
    return res.json({
      success: true,
      data: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        department: u.department,
        designation: u.designation,
        status: u.status,
        role_id: u.role_id,
        role_name: u.role_name,
        is_it_admin: Boolean(u.is_it_admin),
        is_approver: Boolean(u.is_approver),
        is_executive: Boolean(u.is_executive),
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/** Single designated Approver user (role.is_approver). */
async function listApprovers(req, res, next) {
  try {
    const perms = req.authz?.permissions || [];
    const allowed = ['tickets', 'requisitions', 'approvals', 'procurement_log', 'users'].some((p) =>
      perms.includes(p)
    );
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const user = await Role.findDesignatedUser('is_approver');
    return res.json({ success: true, data: user ? [user] : [] });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, data: sanitize(user) });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const {
      name,
      email,
      department,
      designation,
      manager,
      phone,
      status,
      role_id,
      password,
    } = req.body;

    if (!name || !email || !role_id) {
      return res.status(400).json({
        success: false,
        message: 'name, email, and role_id are required',
      });
    }

    const existing = await User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    const role = await Role.findById(role_id);
    if (!role) {
      return res.status(400).json({ success: false, message: 'Invalid role_id' });
    }
    await assertSpecialRoleAssignable(role);

    let password_hash = null;
    let must_setup_password = true;
    if (password) {
      password_hash = await bcrypt.hash(password, 10);
      must_setup_password = false;
    }

    const user = await User.create({
      name,
      email,
      department,
      designation,
      manager,
      phone,
      status: status || 'Active',
      role_id,
      password_hash,
      must_setup_password,
    });

    await addAuditLog({
      user: actor(req),
      action: 'Created User',
      details: `Created user ${user.email}`,
      targetId: String(user.id),
    });

    return res.status(201).json({ success: true, data: user });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const existing = await User.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const {
      name,
      email,
      department,
      designation,
      manager,
      phone,
      status,
      role_id,
      avatar_url,
      password,
    } = req.body;

    if (email && email.toLowerCase() !== existing.email.toLowerCase()) {
      const clash = await User.findByEmail(email);
      if (clash) {
        return res.status(409).json({ success: false, message: 'Email already exists' });
      }
    }

    if (role_id) {
      const role = await Role.findById(role_id);
      if (!role) {
        return res.status(400).json({ success: false, message: 'Invalid role_id' });
      }
      if (Number(role_id) !== Number(existing.role_id)) {
        await assertSpecialRoleAssignable(role, { excludeUserId: existing.id });
      }
    }

    const data = {
      name,
      email,
      department,
      designation,
      manager,
      phone,
      status,
      role_id,
      avatar_url,
    };

    if (password) {
      data.password_hash = await bcrypt.hash(password, 10);
    }

    const user = await User.update(req.params.id, data);
    await addAuditLog({
      user: actor(req),
      action: 'Updated User',
      details: `Updated user ${user.email}`,
      targetId: String(user.id),
    });

    return res.json({ success: true, data: user });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

async function updateStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: 'status is required' });
    }
    const user = await User.updateStatus(req.params.id, status);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    await addAuditLog({
      user: actor(req),
      action: 'Updated User Status',
      details: `Set status of ${user.email} to ${status}`,
      targetId: String(user.id),
    });
    return res.json({ success: true, data: user });
  } catch (err) {
    return next(err);
  }
}

async function updateRole(req, res, next) {
  try {
    const { role_id } = req.body;
    if (!role_id) {
      return res.status(400).json({ success: false, message: 'role_id is required' });
    }
    const role = await Role.findById(role_id);
    if (!role) {
      return res.status(400).json({ success: false, message: 'Invalid role_id' });
    }
    const existing = await User.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (Number(role_id) !== Number(existing.role_id)) {
      await assertSpecialRoleAssignable(role, { excludeUserId: existing.id });
    }
    const user = await User.updateRole(req.params.id, role_id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    await addAuditLog({
      user: actor(req),
      action: 'Updated User Role',
      details: `Assigned role "${role.name}" to ${user.email}`,
      targetId: String(user.id),
    });
    return res.json({ success: true, data: user });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

async function sendPasswordSetup(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const result = await authService.sendSetupOrResetEmail(user.id, 'setup');
    await addAuditLog({
      user: actor(req),
      action: 'Sent Password Setup',
      details: result.delivered
        ? `Password setup email sent to ${user.email}`
        : `Password setup link generated for ${user.email} (SMTP not configured; logged to server console)`,
      targetId: String(user.id),
    });

    if (!result.delivered) {
      return res.json({
        success: true,
        data: {
          delivered: false,
          logged: true,
          email: user.email,
          setupUrl: result.setupUrl,
        },
        message: 'SMTP is not configured. Password setup link was logged to the server console only — no email was sent.',
      });
    }

    return res.json({
      success: true,
      data: { delivered: true, logged: false, email: user.email },
      message: 'Password setup email sent',
    });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (Number(user.id) === Number(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }
    await User.remove(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted User',
      details: `Deleted user ${user.email}`,
      targetId: String(user.id),
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  directory,
  listApprovers,
  get,
  create,
  update,
  updateStatus,
  updateRole,
  sendPasswordSetup,
  remove,
};
