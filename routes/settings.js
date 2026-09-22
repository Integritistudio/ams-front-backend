const express = require('express');
const controller = require('../controllers/settingsController');
const smtpController = require('../controllers/smtpSettingsController');
const fileEncController = require('../controllers/fileEncryptionController');
const openaiController = require('../controllers/openaiSettingsController');
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

router.get('/file-encryption', requirePermission('settings'), fileEncController.get);
router.put('/file-encryption', requirePermission('settings'), fileEncController.update);
router.patch('/file-encryption', requirePermission('settings'), fileEncController.update);
router.delete('/file-encryption', requirePermission('settings'), fileEncController.clear);

router.get('/openai', requirePermission('settings'), openaiController.get);
router.put('/openai', requirePermission('settings'), openaiController.update);
router.patch('/openai', requirePermission('settings'), openaiController.update);

module.exports = router;
