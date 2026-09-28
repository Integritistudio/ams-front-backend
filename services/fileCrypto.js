const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const MIN_KEY_LEN = 16;

let cachedKeyHash = null;
let cachedRawFingerprint = '';

function deriveKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function invalidateKeyCache() {
  cachedKeyHash = null;
  cachedRawFingerprint = '';
}

/** Env-only key material. Empty if not configured (or too short). */
function getEnvKeyRaw() {
  return String(process.env.FILE_ENCRYPTION_KEY || '').trim();
}

function isEncryptionConfigured() {
  return getEnvKeyRaw().length >= MIN_KEY_LEN;
}

/**
 * @param {'upload'|'download'} purpose
 */
function assertKeyConfigured(purpose = 'upload') {
  const raw = getEnvKeyRaw();
  if (raw.length >= MIN_KEY_LEN) return raw;

  const err = new Error(
    purpose === 'download'
      ? 'Attachments cannot be downloaded because FILE_ENCRYPTION_KEY is not set on the server. Contact your administrator.'
      : 'Attachments cannot be uploaded because file encryption is not configured. Contact your administrator to set FILE_ENCRYPTION_KEY in the server environment, or remove the attachment and save without a file.'
  );
  err.status = 503;
  err.code = 'ENCRYPTION_KEY_MISSING';
  throw err;
}

function resolveKeyMaterial(purpose = 'upload') {
  const raw = assertKeyConfigured(purpose);
  if (cachedKeyHash && cachedRawFingerprint === raw) {
    return cachedKeyHash;
  }
  cachedRawFingerprint = raw;
  cachedKeyHash = deriveKey(raw);
  return cachedKeyHash;
}

async function getPublicStatus() {
  const configured = isEncryptionConfigured();
  const raw = getEnvKeyRaw();
  return {
    key_set: configured,
    key_preview: configured ? `${raw.slice(0, 4)}…${raw.slice(-4)}` : null,
    source: configured ? 'env' : 'none',
    message: configured
      ? 'FILE_ENCRYPTION_KEY is set in the server environment. Attachments will be encrypted.'
      : 'FILE_ENCRYPTION_KEY is not set. Uploads with attachments will be rejected until an admin configures it in .env / hosting env.',
  };
}

/** Encrypt a Buffer → { iv, authTag, ciphertext } */
async function encryptBuffer(plain) {
  const key = resolveKeyMaterial('upload');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, authTag, ciphertext };
}

/** Decrypt stored parts → Buffer */
async function decryptBuffer(iv, authTag, ciphertext) {
  const key = resolveKeyMaterial('download');
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
  isEncryptionConfigured,
  invalidateKeyCache,
  MIN_KEY_LEN,
};
