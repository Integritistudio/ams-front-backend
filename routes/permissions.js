const express = require('express');
const controller = require('../controllers/permissionsController');
const { authenticate, attachPermissions } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/me', controller.myPermissions);
router.get('/', controller.myPermissions);

module.exports = router;
