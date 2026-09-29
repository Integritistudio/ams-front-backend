const express = require('express');
const controller = require('../controllers/settingsController');
const smtpController = require('../controllers/smtpSettingsController');
const openaiController = require('../controllers/openaiSettingsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');

const router = express.Router();

// Public branding read (login / portal chrome) — no secrets
router.get('/', controller.get);

router.use(authenticate, attachPermissions);

// Portal settings, encryption, AI — Super Admin only
router.put('/', requireSuperAdmin, controller.update);
router.patch('/', requireSuperAdmin, controller.update);

router.get('/smtp', requireSuperAdmin, smtpController.getSmtp);
router.put('/smtp', requireSuperAdmin, smtpController.updateSmtp);
router.patch('/smtp', requireSuperAdmin, smtpController.updateSmtp);
router.post('/smtp/test', requireSuperAdmin, smtpController.testSmtp);

// Encryption is env-only (FILE_ENCRYPTION_KEY) — no UI/API mutation routes

router.get('/openai', requireSuperAdmin, openaiController.get);
router.put('/openai', requireSuperAdmin, openaiController.update);
router.patch('/openai', requireSuperAdmin, openaiController.update);

module.exports = router;
