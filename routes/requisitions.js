const express = require('express');
const controller = require('../controllers/requisitionsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

function requireAny(...slugs) {
  return (req, res, next) => {
    const permissions = req.authz?.permissions || [];
    if (slugs.some((s) => permissions.includes(s))) return next();
    return res.status(403).json({
      success: false,
      message: `Access denied: missing permission for module "${slugs.join('" or "')}"`,
    });
  };
}

router.get('/', requireAny('requisitions', 'approvals'), controller.list);
router.get('/:id', requireAny('requisitions', 'approvals'), controller.get);
router.post('/', requirePermission('requisitions'), controller.create);
router.put('/:id', requireAny('requisitions', 'approvals'), controller.update);
router.patch('/:id', requireAny('requisitions', 'approvals'), controller.update);
router.delete('/:id', requirePermission('requisitions'), controller.remove);
router.patch('/:id/approve', requirePermission('approvals'), controller.approve);
router.patch('/:id/reject', requirePermission('approvals'), controller.reject);
router.patch('/:id/hold', requireAny('requisitions', 'procurement_log', 'approvals'), controller.hold);
router.patch('/:id/in-progress', requireAny('requisitions', 'approvals'), controller.inProgress);
router.patch('/:id/resume', requireAny('requisitions', 'approvals'), controller.resume);
router.patch('/:id/complete', requireAny('requisitions', 'approvals'), controller.complete);
router.post('/:id/reply', requireAny('requisitions', 'approvals'), controller.reply);
router.post('/:id/replies', requireAny('requisitions', 'approvals'), controller.reply);

module.exports = router;
