const express = require('express');
const controller = require('../controllers/departmentsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', controller.list);
router.post('/', requirePermission('users'), controller.create);

module.exports = router;
