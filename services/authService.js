const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const permissionService = require('./permissionService');
const emailService = require('./emailService');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

async function login(email, password) {
  const result = await db.query(
    `SELECT * FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  const user = result.rows[0];
  if (!user || user.status !== 'Active') {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  if (!user.password_hash) {
    const err = new Error('Password not set. Please use the password setup link sent to your email.');
    err.status = 401;
    throw err;
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }

  const authz = await permissionService.getUserAuthorization(user.id);
  const token = signToken(user);
  return { token, ...authz };
}

async function createPasswordToken(userId, purpose = 'reset', hours = 24) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, purpose, expiresAt]
  );

  return raw;
}

async function consumePasswordToken(rawToken, newPassword) {
  const tokenHash = hashToken(rawToken);
  const result = await db.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error('Invalid or expired token');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.query(
    `UPDATE users SET password_hash = $1, must_setup_password = FALSE, updated_at = NOW() WHERE id = $2`,
    [passwordHash, row.user_id]
  );
  await db.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
  await db.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL AND id <> $2`,
    [row.user_id, row.id]
  );

  return { userId: row.user_id };
}

async function sendSetupOrResetEmail(userId, purpose = 'setup') {
  const userResult = await db.query(`SELECT id, email, name FROM users WHERE id = $1`, [userId]);
  const user = userResult.rows[0];
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const raw = await createPasswordToken(userId, purpose, 24);
  const base = process.env.FRONTEND_URL || 'http://localhost:3001';
  const path = purpose === 'setup' ? 'setup-password' : 'reset-password';
  const url = `${base}/${path}?token=${raw}`;

  if (purpose === 'setup') {
    await emailService.sendPasswordSetupEmail(user, url);
  } else {
    await emailService.sendPasswordResetEmail(user, url);
  }

  return { sent: true };
}

async function changePassword(userId, currentPassword, newPassword) {
  const result = await db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const user = result.rows[0];
  if (!user?.password_hash) {
    const err = new Error('Current password is incorrect');
    err.status = 400;
    throw err;
  }
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    const err = new Error('Current password is incorrect');
    err.status = 400;
    throw err;
  }
  if (!newPassword || newPassword.length < 6) {
    const err = new Error('New password must be at least 6 characters');
    err.status = 400;
    throw err;
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, userId]
  );
}

async function forgotPassword(email) {
  const result = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  const user = result.rows[0];
  // Always return success to avoid email enumeration
  if (user) {
    await sendSetupOrResetEmail(user.id, 'reset');
  }
  return { sent: true };
}

module.exports = {
  login,
  signToken,
  createPasswordToken,
  consumePasswordToken,
  sendSetupOrResetEmail,
  changePassword,
  forgotPassword,
  hashToken,
};
