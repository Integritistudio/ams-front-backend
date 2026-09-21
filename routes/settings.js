const express = require('express');
const controller = require('../controllers/settingsController');
const smtpController = require('../controllers/smtpSettingsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.get('/', controller.get);

router.use(authenticate, attachPermissions);
router.put('/', requirePermission('settings'), controller.update);
router.patch('/', requirePermission('settings'), controller.update);

router.get('/smtp', requirePermission('email_settings'), smtpController.getSmtp);
router.put('/smtp', requirePermission('email_settings'), smtpController.updateSmtp);
router.patch('/smtp', requirePermission('email_settings'), smtpController.updateSmtp);
router.post('/smtp/test', requirePermission('email_settings'), smtpController.testSmtp);

module.exports = router;
