const express = require('express');
const controller = require('../controllers/catalogController');
const { authenticate, attachPermissions } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, attachPermissions);

router.get('/', controller.list);

module.exports = router;
