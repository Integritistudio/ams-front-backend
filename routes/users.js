const express = require('express');
const controller = require('../controllers/usersController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/directory', controller.directory);
router.get('/', requirePermission('users'), controller.list);
router.post('/', requirePermission('users'), controller.create);
router.patch('/:id/status', requirePermission('users'), controller.updateStatus);
router.patch('/:id/role', requirePermission('users'), controller.updateRole);
router.post('/:id/send-password-setup', requirePermission('users'), controller.sendPasswordSetup);
router.get('/:id', requirePermission('users'), controller.get);
router.put('/:id', requirePermission('users'), controller.update);
router.patch('/:id', requirePermission('users'), controller.update);
router.delete('/:id', requirePermission('users'), controller.remove);

module.exports = router;
