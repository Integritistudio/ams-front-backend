const express = require('express');
const controller = require('../controllers/emailTemplatesController');
const { authenticate, attachPermissions } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', requirePermission('email_settings'), controller.list);
router.get('/:id', requirePermission('email_settings'), controller.get);
router.post('/', requirePermission('email_settings'), controller.create);
router.put('/:id', requirePermission('email_settings'), controller.update);
router.patch('/:id', requirePermission('email_settings'), controller.update);
router.delete('/:id', requirePermission('email_settings'), controller.remove);

module.exports = router;
