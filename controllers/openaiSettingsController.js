const openaiSettings = require('../services/openaiSettings');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function get(req, res, next) {
  try {
    const data = await openaiSettings.getPublicStatus();
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const body = req.body || {};
    const data = await openaiSettings.updateSettings(body);
    await addAuditLog({
      user: actor(req),
      action: body.clear_key ? 'Cleared OpenAI API Key' : 'Updated OpenAI Settings',
      details: `AI provider=${data.provider}; model=${data.model}; key_set=${data.key_set}`,
      targetId: 'openai',
    });
    return res.json({
      success: true,
      data,
      message: body.clear_key ? 'AI API key cleared' : 'AI settings saved',
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { get, update };
