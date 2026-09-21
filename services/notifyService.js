const { addNotification } = require('./auditService');
const emailService = require('./emailService');
const { eventEmail } = require('./emailTemplates');

/**
 * Create in-app notification and send branded SMTP email (best-effort).
 * Email failures do not fail the main request.
 */
async function notifyUser({
  targetEmail,
  subject,
  text,
  title,
  type = 'info',
  ctaLabel,
  ctaUrl,
}) {
  const email = (targetEmail || '').trim().toLowerCase();
  if (!email) return { notified: false, emailed: false };

  await addNotification({
    targetEmail: email,
    subject,
    text,
    type,
  });

  try {
    const { subject: mailSubject, text: mailText, html } = await eventEmail({
      title: title || subject,
      greeting: 'Hello,',
      bodyText: text,
      subject,
      ctaLabel,
      ctaUrl,
      type,
    });
    const result = await emailService.sendMail({
      to: email,
      subject: mailSubject,
      text: mailText,
      html,
    });
    return { notified: true, emailed: Boolean(result?.delivered), logged: Boolean(result?.logged) };
  } catch (err) {
    console.error('notifyUser email failed:', err.message);
    return { notified: true, emailed: false, error: err.message };
  }
}

async function notifyMany(emails, payload) {
  const unique = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const results = [];
  for (const email of unique) {
    results.push(await notifyUser({ ...payload, targetEmail: email }));
  }
  return results;
}

module.exports = { notifyUser, notifyMany };
