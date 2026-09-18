const express = require('express');
const controller = require('../controllers/procurementController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('procurement_log'), controller.list);
router.get('/:id', requirePermission('procurement_log'), controller.get);
router.post('/', requirePermission('procurement_log'), controller.create);
router.put('/:id', requirePermission('procurement_log'), controller.update);
router.patch('/:id', requirePermission('procurement_log'), controller.update);
router.delete('/:id', requirePermission('procurement_log'), controller.remove);

module.exports = router;
