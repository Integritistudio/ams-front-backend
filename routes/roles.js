const express = require('express');
const controller = require('../controllers/rolesController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

function requireRolesOrUsers(req, res, next) {
  const perms = req.authz?.permissions || [];
  if (perms.includes('roles') || perms.includes('users')) return next();
  return res.status(403).json({
    success: false,
    message: 'Access denied: missing permission for module "roles"',
  });
}

router.use(authenticate, attachPermissions);

router.get('/', requireRolesOrUsers, controller.list);
router.post('/', requirePermission('roles'), controller.create);
router.get('/:id/users', requirePermission('roles'), controller.getUsers);
router.get('/:id/permissions', requirePermission('roles'), controller.getPermissions);
router.put('/:id/permissions', requirePermission('roles'), controller.setPermissions);
router.get('/:id', requirePermission('roles'), controller.get);
router.put('/:id', requirePermission('roles'), controller.update);
router.patch('/:id', requirePermission('roles'), controller.update);
router.delete('/:id', requirePermission('roles'), controller.remove);

module.exports = router;
