const express = require('express');
const controller = require('../controllers/emailTemplatesController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

// Email templates / triggers — Super Admin only
router.get('/catalog', requireSuperAdmin, controller.catalog);
router.get('/triggers', requireSuperAdmin, controller.triggersList);
router.put('/triggers', requireSuperAdmin, controller.triggersUpdate);
router.patch('/triggers', requireSuperAdmin, controller.triggersUpdate);
router.post('/preview', requireSuperAdmin, controller.preview);
router.get('/preview-card/:eventKey', requireSuperAdmin, controller.previewCard);
router.post('/preview-card/:eventKey', requireSuperAdmin, controller.previewCard);
router.get('/', requireSuperAdmin, controller.list);
router.post('/', requireSuperAdmin, controller.create);
router.get('/:id', requireSuperAdmin, controller.get);
router.put('/:id', requireSuperAdmin, controller.update);
router.patch('/:id', requireSuperAdmin, controller.update);
router.post('/:id/reset-defaults', requireSuperAdmin, controller.resetDefaults);
router.delete('/:id', requireSuperAdmin, controller.remove);

module.exports = router;
