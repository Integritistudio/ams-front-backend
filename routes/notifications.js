const express = require('express');
const controller = require('../controllers/notificationsController');
const { authenticate, attachPermissions } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', controller.list);
router.delete('/', controller.clear);
router.post('/clear', controller.clear);

module.exports = router;
