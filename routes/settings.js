const express = require('express');
const controller = require('../controllers/settingsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.get('/', controller.get);

router.use(authenticate, attachPermissions);
router.put('/', requirePermission('settings'), controller.update);
router.patch('/', requirePermission('settings'), controller.update);

module.exports = router;
