const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Role = require('../models/Role');
const authService = require('../services/authService');
const { addAuditLog } = require('../services/auditService');
const { notifyUser } = require('../services/notifyService');
const { assertSpecialRoleAssignable } = require('./rolesController');
const {
  previewTransfer,
  executeTransfer,
  reassignPendingWork,
  kindFromRole,
} = require('../services/specialRoleTransferService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

function portalUrl(path = '') {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : path ? `/${path}` : ''}`;
}

function sanitize(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

function sendControllerError(res, err, next) {
  if (err.status) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      code: err.code || undefined,
      data: err.payload || undefined,
    });
  }
  return next(err);
}

/**
 * If role is IT Admin / Approver and already held, either return a transfer
 * preview conflict or (when confirmed) demote the previous holder.
 */
async function handleSpecialRoleAssignment(role, {
  excludeUserId = null,
  body = {},
  newUser = null,
  demoteOnly = false,
} = {}) {
  if (!role?.is_it_admin && !role?.is_approver) return null;

  const preview = await previewTransfer(role, { excludeUserId });
  if (!preview?.required) {
    await assertSpecialRoleAssignable(role, { excludeUserId });
    return null;
  }

  if (!body.confirm_special_role_transfer) {
    const parts = [];
    if (preview.kind === 'Approver') {
      parts.push(`${preview.pending.requisitions} pending approval(s)`);
    } else {
      parts.push(`${preview.pending.tickets} open ticket(s)`);
      parts.push(`${preview.pending.requisitions} IT-queue asset request(s)`);
    }
    const err = new Error(
      `${preview.kind} is currently assigned to ${preview.currentHolder.name}. ` +
        `On confirmation, ${parts.join(' and ')} will be assigned to the new person, ` +
        `and ${preview.currentHolder.name} will be moved to another role.`
    );
    err.status = 409;
    err.code = 'SPECIAL_ROLE_TRANSFER_REQUIRED';
    err.payload = preview;
    throw err;
  }

  return executeTransfer({
    role,
    newUser: demoteOnly ? null : newUser,
    demotePreviousToRoleId: body.demote_previous_to_role_id || null,
    demoteOnly,
  });
}

async function notifyTransferParties({ transfer, newUser, role }) {
  if (!transfer?.transferred || !transfer.previousHolder || !newUser) return;
  const kind = transfer.kind || kindFromRole(role);
  const moved =
    kind === 'Approver'
      ? `${transfer.reassigned?.requisitions || 0} pending approval(s)`
      : `${transfer.reassigned?.tickets || 0} open ticket(s) and ${transfer.reassigned?.requisitions || 0} IT-queue asset request(s)`;

  if (transfer.previousHolder.email) {
    await notifyUser({
      targetEmail: transfer.previousHolder.email,
      subject: `${kind} role transferred`,
      title: `${kind} role reassigned`,
      text:
        `Your ${kind} designation was transferred to ${newUser.name}. ` +
        `You were moved to role "${transfer.demotedToRoleName || 'another role'}". ` +
        `Pending work (${moved}) was reassigned to ${newUser.name}.`,
      type: 'warning',
      ctaLabel: 'Open portal',
      ctaUrl: portalUrl('/'),
      name: transfer.previousHolder.name,
    });
  }

  if (newUser.email) {
    await notifyUser({
      targetEmail: newUser.email,
      subject: `You are now the designated ${kind}`,
      title: `You are now ${kind}`,
      text:
        `You have been designated as ${kind}, replacing ${transfer.previousHolder.name}. ` +
        `Pending work (${moved}) has been assigned to you.`,
      type: 'info',
      ctaLabel: 'Open portal',
      ctaUrl: portalUrl('/'),
      name: newUser.name,
    });
  }
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
    const users = await User.findAll({ status: 'Active', includeDeleted: false });
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
        avatar_url: u.avatar_url || null,
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

/** Executive users (role.is_executive) — may be multiple. */
async function listExecutives(req, res, next) {
  try {
    const perms = req.authz?.permissions || [];
    const allowed = ['tickets', 'requisitions', 'approvals', 'procurement_log', 'users'].some((p) =>
      perms.includes(p)
    );
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const users = await Role.findUsersWithFlag('is_executive');
    return res.json({ success: true, data: users });
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
      avatar_url,
    } = req.body;

    if (!name || !email || !role_id) {
      return res.status(400).json({
        success: false,
        message: 'name, email, and role_id are required',
      });
    }

    const existing = await User.findByEmail(email, { includeDeleted: false });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }
    const deletedSame = await User.findByEmail(email, { includeDeleted: true });
    if (deletedSame && deletedSame.status === 'Deleted') {
      return res.status(409).json({
        success: false,
        message:
          'A soft-deleted user already uses this email. Restore that user instead of creating a new one.',
      });
    }

    const role = await Role.findById(role_id);
    if (!role) {
      return res.status(400).json({ success: false, message: 'Invalid role_id' });
    }

    const transferPrep = await handleSpecialRoleAssignment(role, {
      body: req.body,
      demoteOnly: true,
    });
    const previousHolder = transferPrep?.previousHolder || null;
    const transferKind = transferPrep?.kind || kindFromRole(role);

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
      avatar_url: avatar_url || null,
    });

    let transferResult = transferPrep;
    if (transferPrep?.transferred && previousHolder && transferKind) {
      const reassigned = await reassignPendingWork(transferKind, previousHolder, user);
      transferResult = { ...transferPrep, reassigned };
      await notifyTransferParties({ transfer: transferResult, newUser: user, role });
      await addAuditLog({
        user: actor(req),
        action: `Transferred ${transferKind}`,
        details:
          `${transferKind} transferred from ${previousHolder.name} to ${user.name}. ` +
          `Previous user moved to "${transferPrep.demotedToRoleName}". ` +
          `Reassigned: ${reassigned.requisitions || 0} request(s), ${reassigned.tickets || 0} ticket(s).`,
        targetId: String(user.id),
      });
    }

    await addAuditLog({
      user: actor(req),
      action: 'Created User',
      details: `Created user ${user.email}`,
      targetId: String(user.id),
    });

    // Notify new user about account creation
    await notifyUser({
      targetEmail: user.email,
      subject: 'Your IT Service Desk account has been created',
      title: 'Welcome to IT Service Desk',
      text: password
        ? `An administrator created an IT Service Desk account for you (${user.email}). You can sign in with the password provided by your administrator.`
        : `An administrator created an IT Service Desk account for you (${user.email}). A password setup link will be sent separately so you can choose your password.`,
      type: 'info',
      ctaLabel: 'Open portal',
      ctaUrl: portalUrl('/login'),
      name: user.name,
    });

    // Auto-send password setup email when no password was set at create time
    let passwordSetup = null;
    if (!password) {
      try {
        passwordSetup = await authService.sendSetupOrResetEmail(user.id, 'setup');
        await addAuditLog({
          user: actor(req),
          action: 'Sent Password Setup',
          details: passwordSetup.delivered
            ? `Password setup email auto-sent to ${user.email}`
            : `Password setup link generated for ${user.email} (SMTP not configured; logged to server console)`,
          targetId: String(user.id),
        });
      } catch (setupErr) {
        console.error('Auto password setup email failed:', setupErr.message);
      }
    }

    return res.status(201).json({
      success: true,
      data: user,
      transfer: transferResult?.transferred ? transferResult : undefined,
      message: password
        ? 'User created.'
        : passwordSetup?.delivered
          ? 'User created. Password setup email sent.'
          : 'User created. Password setup link generated (check SMTP / server console if email was not delivered).',
      passwordSetup: passwordSetup
        ? {
            delivered: Boolean(passwordSetup.delivered),
            logged: Boolean(passwordSetup.logged),
          }
        : null,
    });
  } catch (err) {
    return sendControllerError(res, err, next);
  }
}

async function update(req, res, next) {
  try {
    const existing = await User.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (existing.status === 'Deleted') {
      return res.status(400).json({
        success: false,
        message: 'User is soft-deleted. Restore them before editing.',
      });
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

    let transferResult = null;
    let role = null;
    if (role_id) {
      role = await Role.findById(role_id);
      if (!role) {
        return res.status(400).json({ success: false, message: 'Invalid role_id' });
      }
      if (Number(role_id) !== Number(existing.role_id)) {
        transferResult = await handleSpecialRoleAssignment(role, {
          excludeUserId: existing.id,
          body: req.body,
          newUser: {
            id: existing.id,
            name: name || existing.name,
            email: email || existing.email,
          },
        });
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

    if (transferResult?.transferred) {
      await notifyTransferParties({ transfer: transferResult, newUser: user, role });
      await addAuditLog({
        user: actor(req),
        action: `Transferred ${transferResult.kind}`,
        details:
          `${transferResult.kind} transferred from ${transferResult.previousHolder.name} to ${user.name}. ` +
          `Previous user moved to "${transferResult.demotedToRoleName}". ` +
          `Reassigned: ${transferResult.reassigned?.requisitions || 0} request(s), ` +
          `${transferResult.reassigned?.tickets || 0} ticket(s).`,
        targetId: String(user.id),
      });
    }

    await addAuditLog({
      user: actor(req),
      action: 'Updated User',
      details: `Updated user ${user.email}`,
      targetId: String(user.id),
    });

    // Notify the user that their account information was updated
    const notifyEmail = (user.email || existing.email || '').toLowerCase();
    if (notifyEmail) {
      const changedBits = [];
      if (name && name !== existing.name) changedBits.push('name');
      if (email && email.toLowerCase() !== existing.email.toLowerCase()) changedBits.push('email');
      if (department !== undefined && department !== existing.department) changedBits.push('department');
      if (designation !== undefined && designation !== existing.designation) changedBits.push('designation');
      if (manager !== undefined && manager !== existing.manager) changedBits.push('manager');
      if (phone !== undefined && phone !== existing.phone) changedBits.push('phone');
      if (status && status !== existing.status) changedBits.push('status');
      if (role_id && Number(role_id) !== Number(existing.role_id)) changedBits.push('role');
      if (password) changedBits.push('password');

      const changeText = changedBits.length
        ? `Updated fields: ${changedBits.join(', ')}.`
        : 'Your account details were updated by an administrator.';

      await notifyUser({
        targetEmail: notifyEmail,
        subject: 'Your IT Service Desk account was updated',
        title: 'Account information updated',
        text: `An administrator updated your IT Service Desk profile. ${changeText}`,
        type: 'info',
        ctaLabel: 'View my account',
        ctaUrl: portalUrl('/account'),
        name: user.name || existing.name,
      });
    }

    return res.json({
      success: true,
      data: user,
      transfer: transferResult?.transferred ? transferResult : undefined,
    });
  } catch (err) {
    return sendControllerError(res, err, next);
  }
}

async function updateStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: 'status is required' });
    }
    if (String(status).toLowerCase() === 'deleted') {
      return res.status(400).json({
        success: false,
        message: 'Use DELETE /api/users/:id?confirm=1 to soft-delete a user',
      });
    }
    const existing = await User.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (existing.status === 'Deleted') {
      return res.status(400).json({
        success: false,
        message: 'User is soft-deleted. Restore them first.',
      });
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

    let transferResult = null;
    if (Number(role_id) !== Number(existing.role_id)) {
      transferResult = await handleSpecialRoleAssignment(role, {
        excludeUserId: existing.id,
        body: req.body,
        newUser: existing,
      });
    }

    const user = await User.updateRole(req.params.id, role_id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (transferResult?.transferred) {
      await notifyTransferParties({ transfer: transferResult, newUser: user, role });
      await addAuditLog({
        user: actor(req),
        action: `Transferred ${transferResult.kind}`,
        details:
          `${transferResult.kind} transferred from ${transferResult.previousHolder.name} to ${user.name}. ` +
          `Previous user moved to "${transferResult.demotedToRoleName}". ` +
          `Reassigned: ${transferResult.reassigned?.requisitions || 0} request(s), ` +
          `${transferResult.reassigned?.tickets || 0} ticket(s).`,
        targetId: String(user.id),
      });
    }

    await addAuditLog({
      user: actor(req),
      action: 'Updated User Role',
      details: `Assigned role "${role.name}" to ${user.email}`,
      targetId: String(user.id),
    });
    return res.json({
      success: true,
      data: user,
      transfer: transferResult?.transferred ? transferResult : undefined,
    });
  } catch (err) {
    return sendControllerError(res, err, next);
  }
}

async function specialRoleTransferPreview(req, res, next) {
  try {
    const roleId = Number(req.query.role_id);
    const forUserId = req.query.for_user_id ? Number(req.query.for_user_id) : null;
    if (!roleId) {
      return res.status(400).json({ success: false, message: 'role_id is required' });
    }
    const role = await Role.findById(roleId);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Role not found' });
    }
    if (!role.is_it_admin && !role.is_approver) {
      return res.json({
        success: true,
        data: { required: false, kind: null, currentHolder: null, pending: { total: 0 } },
      });
    }
    const preview = await previewTransfer(role, { excludeUserId: forUserId });
    return res.json({ success: true, data: preview });
  } catch (err) {
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

async function relatedSummary(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const related = await User.relatedSummary(req.params.id);
    const total =
      related.tickets +
      related.requisitions +
      related.approvals_assigned +
      related.assets +
      related.uploads;
    return res.json({
      success: true,
      data: {
        user: sanitize(user),
        related,
        total_linked: total,
        soft_delete: true,
        message:
          'Soft delete keeps this account and all linked tickets, requests, assets, and uploads. The user will no longer be able to sign in.',
      },
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
    if (user.status === 'Deleted') {
      return res.status(400).json({ success: false, message: 'User is already deleted' });
    }

    const related = await User.relatedSummary(req.params.id);
    const confirmed = req.query.confirm === '1' || req.body?.confirm === true;
    if (!confirmed) {
      return res.status(409).json({
        success: false,
        code: 'CONFIRM_SOFT_DELETE',
        message:
          'Confirm soft delete. Linked tickets, asset requests, assets, and uploads will remain in the system and stay linked to this user.',
        data: { related, soft_delete: true },
      });
    }

    const deleted = await User.softDelete(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Soft Deleted User',
      details: `Soft-deleted user ${user.email} (tickets=${related.tickets}, requisitions=${related.requisitions}, assets=${related.assets})`,
      targetId: String(user.id),
    });
    return res.json({
      success: true,
      data: { deleted: true, soft: true, user: sanitize(deleted), related },
      message: 'User soft-deleted. Linked records were kept.',
    });
  } catch (err) {
    return next(err);
  }
}

async function restore(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.status !== 'Deleted') {
      return res.status(400).json({ success: false, message: 'User is not deleted' });
    }
    const restored = await User.restore(req.params.id);
    await addAuditLog({
      user: actor(req),
      action: 'Restored User',
      details: `Restored soft-deleted user ${user.email}`,
      targetId: String(user.id),
    });
    return res.json({ success: true, data: sanitize(restored), message: 'User restored to Active.' });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  directory,
  listApprovers,
  listExecutives,
  get,
  create,
  update,
  updateStatus,
  updateRole,
  specialRoleTransferPreview,
  sendPasswordSetup,
  relatedSummary,
  remove,
  restore,
};
