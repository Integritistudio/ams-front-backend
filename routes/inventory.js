const express = require('express');
const controller = require('../controllers/inventoryController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission, requireAny } = require('../middleware/permissions');

const router = express.Router();
router.use(authenticate, attachPermissions);

router.get('/', requireAny('inventory', 'assign_assets', 'requisitions', 'approvals'), controller.list);
router.get('/:id', requireAny('inventory', 'assign_assets'), controller.get);
router.post('/', requirePermission('inventory'), controller.create);
router.put('/:id', requirePermission('inventory'), controller.update);
router.patch('/:id', requirePermission('inventory'), controller.update);
router.delete('/:id', requirePermission('inventory'), controller.remove);

module.exports = router;
