const express = require('express');
const controller = require('../controllers/vendorsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('vendors'), controller.list);
router.get('/:id', requirePermission('vendors'), controller.get);
router.post('/', requirePermission('vendors'), controller.create);
router.put('/:id', requirePermission('vendors'), controller.update);
router.patch('/:id', requirePermission('vendors'), controller.update);
router.delete('/:id', requirePermission('vendors'), controller.remove);

module.exports = router;
