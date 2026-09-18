const express = require('express');
const controller = require('../controllers/modulesController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('roles'), controller.list);

module.exports = router;
