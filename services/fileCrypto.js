const crypto = require('crypto');
const db = require('../config/database');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKeyHash = null;
let cachedRawFingerprint = '';

async function ensureRow() {
  await db.query(
    `INSERT INTO file_encryption_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );
}

async function getStoredKeyRaw() {
  await ensureRow();
  const result = await db.query(
    `SELECT encryption_key, updated_at FROM file_encryption_settings WHERE id = 1`
  );
  return result.rows[0] || null;
}

function deriveKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function invalidateKeyCache() {
  cachedKeyHash = null;
  cachedRawFingerprint = '';
}

/** Resolve AES key material: DB admin key first, then env fallbacks. */
async function resolveKeyMaterial() {
  const row = await getStoredKeyRaw();
  const fromDb = row?.encryption_key ? String(row.encryption_key).trim() : '';
  const raw =
    fromDb ||
    process.env.FILE_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'dev-file-encryption-key';

  if (cachedKeyHash && cachedRawFingerprint === raw) {
    return cachedKeyHash;
  }
  cachedRawFingerprint = raw;
  cachedKeyHash = deriveKey(raw);
  return cachedKeyHash;
}

async function getPublicStatus() {
  const row = await getStoredKeyRaw();
  const key = row?.encryption_key ? String(row.encryption_key).trim() : '';
  return {
    key_set: Boolean(key),
    key_preview: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
    source: key ? 'database' : (process.env.FILE_ENCRYPTION_KEY ? 'env' : 'fallback'),
    updated_at: row?.updated_at || null,
  };
}

function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

async function updateEncryptionKey({ encryption_key, generate } = {}) {
  await ensureRow();
  let next = encryption_key !== undefined ? String(encryption_key || '').trim() : undefined;

  if (generate) {
    next = generateKey();
  }

  if (next === undefined) {
    const status = await getPublicStatus();
    return { ...status, generated_key: null };
  }

  if (next.length < 16) {
    const err = new Error('Encryption key must be at least 16 characters');
    err.status = 400;
    throw err;
  }

  await db.query(
    `UPDATE file_encryption_settings
     SET encryption_key = $1, updated_at = NOW()
     WHERE id = 1`,
    [next]
  );
  invalidateKeyCache();

  const status = await getPublicStatus();
  return {
    ...status,
    // Only return full key when newly generated so admin can copy once
    generated_key: generate ? next : null,
  };
}

async function clearEncryptionKey() {
  await ensureRow();
  await db.query(
    `UPDATE file_encryption_settings
     SET encryption_key = NULL, updated_at = NOW()
     WHERE id = 1`
  );
  invalidateKeyCache();
  return getPublicStatus();
}

/** Encrypt a Buffer → { iv, authTag, ciphertext } */
async function encryptBuffer(plain) {
  const key = await resolveKeyMaterial();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, authTag, ciphertext };
}

/** Decrypt stored parts → Buffer */
async function decryptBuffer(iv, authTag, ciphertext) {
  const key = await resolveKeyMaterial();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.isBuffer(iv) ? iv : Buffer.from(iv));
  decipher.setAuthTag(Buffer.isBuffer(authTag) ? authTag : Buffer.from(authTag));
  return Buffer.concat([
    decipher.update(Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext)),
    decipher.final(),
  ]);
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  getPublicStatus,
  updateEncryptionKey,
  clearEncryptionKey,
  generateKey,
  invalidateKeyCache,
};
