const express = require('express');
const controller = require('../controllers/emailTemplatesController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/catalog', requirePermission('email_settings'), controller.catalog);
router.get('/triggers', requirePermission('email_settings'), controller.triggersList);
router.put('/triggers', requirePermission('email_settings'), controller.triggersUpdate);
router.patch('/triggers', requirePermission('email_settings'), controller.triggersUpdate);
router.post('/preview', requirePermission('email_settings'), controller.preview);
router.get('/preview-card/:eventKey', requirePermission('email_settings'), controller.previewCard);
router.post('/preview-card/:eventKey', requirePermission('email_settings'), controller.previewCard);
router.get('/', requirePermission('email_settings'), controller.list);
router.post('/', requirePermission('email_settings'), controller.create);
router.get('/:id', requirePermission('email_settings'), controller.get);
router.put('/:id', requirePermission('email_settings'), controller.update);
router.patch('/:id', requirePermission('email_settings'), controller.update);
router.post('/:id/reset-defaults', requirePermission('email_settings'), controller.resetDefaults);
router.delete('/:id', requirePermission('email_settings'), controller.remove);

module.exports = router;
