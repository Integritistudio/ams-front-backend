const express = require('express');
const controller = require('../controllers/logsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('logs'), controller.list);
router.delete('/', requirePermission('logs'), controller.clear);
router.post('/clear', requirePermission('logs'), controller.clear);

module.exports = router;
