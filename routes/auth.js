const express = require('express');
const controller = require('../controllers/authController');
const { authenticate, attachPermissions } = require('../middleware/auth');

const router = express.Router();

router.post('/login', controller.login);
router.post('/forgot-password', controller.forgotPassword);
router.post('/reset-password', controller.resetPassword);
router.post('/setup-password', controller.setupPassword);

router.get('/me', authenticate, attachPermissions, controller.me);
router.patch('/profile', authenticate, attachPermissions, controller.updateProfile);
router.post('/change-password', authenticate, attachPermissions, controller.changePassword);
router.patch('/change-password', authenticate, attachPermissions, controller.changePassword);
router.post('/logout', authenticate, attachPermissions, controller.logout);

module.exports = router;
