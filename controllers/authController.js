const authService = require('../services/authService');
const { addAuditLog } = require('../services/auditService');
const permissionService = require('../services/permissionService');

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 8 * 60 * 60 * 1000,
};

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const result = await authService.login(email, password);
    res.cookie('token', result.token, cookieOpts);
    await addAuditLog({
      user: { ...result.user, role: result.role },
      action: 'Login',
      details: `User ${result.user.email} signed in`,
      targetId: String(result.user.id),
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

async function logout(req, res, next) {
  try {
    res.clearCookie('token');
    if (req.authz?.user) {
      await addAuditLog({
        user: { ...req.authz.user, role: req.authz.role },
        action: 'Logout',
        details: `User ${req.authz.user.email} signed out`,
        targetId: String(req.authz.user.id),
      });
    }
    return res.json({ success: true, data: { loggedOut: true } });
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const authz = req.authz || (await permissionService.getUserAuthorization(req.user.id));
    if (!authz) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }
    return res.json({ success: true, data: authz });
  } catch (err) {
    return next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    await authService.forgotPassword(email);
    return res.json({
      success: true,
      data: { sent: true },
      message: 'If that email exists, a reset link has been sent',
    });
  } catch (err) {
    return next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password, newPassword } = req.body;
    const pwd = password || newPassword;
    if (!token || !pwd) {
      return res.status(400).json({ success: false, message: 'Token and password are required' });
    }
    if (pwd.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    const result = await authService.consumePasswordToken(token, pwd);
    await addAuditLog({
      user: { name: 'System', email: 'system@integriti.io', role: { name: 'System' } },
      action: 'Password Reset',
      details: 'Password reset completed via token',
      targetId: String(result.userId),
    });
    return res.json({ success: true, data: { reset: true }, message: 'Password updated successfully' });
  } catch (err) {
    return next(err);
  }
}

async function setupPassword(req, res, next) {
  try {
    const { token, password, newPassword } = req.body;
    const pwd = password || newPassword;
    if (!token || !pwd) {
      return res.status(400).json({ success: false, message: 'Token and password are required' });
    }
    if (pwd.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    const result = await authService.consumePasswordToken(token, pwd);
    await addAuditLog({
      user: { name: 'System', email: 'system@integriti.io', role: { name: 'System' } },
      action: 'Password Setup',
      details: 'Initial password setup completed via token',
      targetId: String(result.userId),
    });
    return res.json({ success: true, data: { setup: true }, message: 'Password set successfully' });
  } catch (err) {
    return next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required' });
    }
    await authService.changePassword(req.user.id, currentPassword, newPassword);
    await addAuditLog({
      user: { ...req.authz.user, role: req.authz.role },
      action: 'Change Password',
      details: 'User changed their password',
      targetId: String(req.user.id),
    });
    return res.json({ success: true, data: { changed: true }, message: 'Password changed successfully' });
  } catch (err) {
    return next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const User = require('../models/User');
    const { name, phone, avatar_url } = req.body;
    const updated = await User.update(req.user.id, {
      name,
      phone,
      avatar_url,
    });
    const authz = await permissionService.getUserAuthorization(req.user.id);
    await addAuditLog({
      user: { ...req.authz.user, role: req.authz.role },
      action: 'Update Profile',
      details: 'User updated their profile',
      targetId: String(req.user.id),
    });
    return res.json({ success: true, data: { user: updated, ...authz } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  login,
  logout,
  me,
  forgotPassword,
  resetPassword,
  setupPassword,
  changePassword,
  updateProfile,
};
