const express = require('express');
const controller = require('../controllers/assetsController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/mine', requirePermission('my_assets'), controller.listMine);
router.get('/', requirePermission('assign_assets'), controller.listAll);
router.post('/', requirePermission('assign_assets'), controller.create);
router.put('/:id', requirePermission('assign_assets'), controller.update);
router.patch('/:id', requirePermission('assign_assets'), controller.update);
router.delete('/:id', requirePermission('assign_assets'), controller.remove);

module.exports = router;
