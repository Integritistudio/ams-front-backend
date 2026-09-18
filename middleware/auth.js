const jwt = require('jsonwebtoken');
const permissionService = require('../services/permissionService');

function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (_err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

async function attachPermissions(req, res, next) {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const authz = await permissionService.getUserAuthorization(req.user.id);
    if (!authz) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }
    req.authz = authz;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { authenticate, attachPermissions };
