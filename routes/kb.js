const express = require('express');
const controller = require('../controllers/kbController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('knowledge_base'), controller.list);
router.get('/:id', requirePermission('knowledge_base'), controller.get);

module.exports = router;
