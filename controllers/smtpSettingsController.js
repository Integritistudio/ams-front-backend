const emailService = require('../services/emailService');
const { addAuditLog } = require('../services/auditService');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function getSmtp(req, res, next) {
  try {
    const data = await emailService.getPublicSmtpSettings();
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

async function updateSmtp(req, res, next) {
  try {
    const data = await emailService.updateSmtpSettings(req.body || {});
    await addAuditLog({
      user: actor(req),
      action: 'Updated SMTP Settings',
      details: `SMTP ${data.enabled ? 'enabled' : 'disabled'} via ${data.host || 'n/a'} as ${data.username || 'n/a'}`,
      targetId: 'smtp',
    });
    return res.json({ success: true, data, message: 'SMTP settings saved' });
  } catch (err) {
    return next(err);
  }
}

async function testSmtp(req, res, next) {
  try {
    const to = req.body?.to || req.authz?.user?.email;
    const result = await emailService.sendTestEmail(to);
    await addAuditLog({
      user: actor(req),
      action: 'Tested SMTP',
      details: `Test email sent to ${result.to}`,
      targetId: 'smtp',
    });
    return res.json({
      success: true,
      data: result,
      message: `Test email sent to ${result.to}`,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getSmtp, updateSmtp, testSmtp };
