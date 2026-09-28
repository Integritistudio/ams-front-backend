const fileCrypto = require('../services/fileCrypto');

/** Read-only status — encryption key is configured via FILE_ENCRYPTION_KEY in env only. */
async function get(req, res, next) {
  try {
    const data = await fileCrypto.getPublicStatus();
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res) {
  return res.status(405).json({
    success: false,
    message:
      'Attachment encryption keys can no longer be set in the UI. Set FILE_ENCRYPTION_KEY in the server environment (.env) and restart the API.',
  });
}

async function clear(req, res) {
  return res.status(405).json({
    success: false,
    message:
      'Attachment encryption keys are managed via FILE_ENCRYPTION_KEY in the server environment only.',
  });
}

module.exports = { get, update, clear };
