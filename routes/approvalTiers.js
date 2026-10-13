const express = require('express');
const controller = require('../controllers/approvalTiersController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

// Any signed-in user may read tiers (approval screens show the approver role / limits)
router.get('/', controller.list);

// Configuring approvers and limits is Super Admin only (same as portal settings)
router.post('/', requireSuperAdmin, controller.create);
router.put('/:id', requireSuperAdmin, controller.update);
router.patch('/:id', requireSuperAdmin, controller.update);
router.delete('/:id', requireSuperAdmin, controller.remove);

module.exports = router;
