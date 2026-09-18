const express = require('express');
const controller = require('../controllers/ticketsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('tickets'), controller.list);
router.get('/:id', requirePermission('tickets'), controller.get);
router.post('/', requirePermission('tickets'), controller.create);
router.put('/:id', requirePermission('tickets'), controller.update);
router.patch('/:id', requirePermission('tickets'), controller.update);
router.delete('/:id', requirePermission('tickets'), controller.remove);
router.patch('/:id/in-progress', requirePermission('tickets'), controller.inProgress);
router.patch('/:id/hold', requirePermission('tickets'), controller.hold);
router.patch('/:id/resume', requirePermission('tickets'), controller.resume);
router.patch('/:id/resolve', requirePermission('tickets'), controller.resolve);
router.post('/:id/reply', requirePermission('tickets'), controller.reply);

module.exports = router;
