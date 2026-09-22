const fileCrypto = require('../services/fileCrypto');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function get(req, res, next) {
  try {
    const data = await fileCrypto.getPublicStatus();
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const body = req.body || {};
    const data = await fileCrypto.updateEncryptionKey({
      encryption_key: body.encryption_key,
      generate: Boolean(body.generate),
    });
    await addAuditLog({
      user: actor(req),
      action: body.generate ? 'Generated File Encryption Key' : 'Updated File Encryption Key',
      details: 'Attachment encryption key saved in database (admin Settings)',
      targetId: 'file-encryption',
    });
    return res.json({
      success: true,
      data,
      message: body.generate
        ? 'New encryption key generated and saved. Copy it now if you need a backup.'
        : 'Encryption key saved',
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

async function clear(req, res, next) {
  try {
    const data = await fileCrypto.clearEncryptionKey();
    await addAuditLog({
      user: actor(req),
      action: 'Cleared File Encryption Key',
      details: 'DB encryption key cleared; env/fallback will be used if set',
      targetId: 'file-encryption',
    });
    return res.json({ success: true, data, message: 'Encryption key cleared from database' });
  } catch (err) {
    return next(err);
  }
}

module.exports = { get, update, clear };
