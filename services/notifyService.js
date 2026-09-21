const db = require('../config/database');
const { addNotification } = require('./auditService');
const emailService = require('./emailService');
const { eventEmail } = require('./emailTemplates');

async function resolveUserName(email, explicitName) {
  if (explicitName && String(explicitName).trim()) {
    return String(explicitName).trim();
  }
  try {
    const result = await db.query(
      `SELECT name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    return result.rows[0]?.name || null;
  } catch (_e) {
    return null;
  }
}

function greetingFor(name) {
  if (!name) return 'Hello,';
  const first = String(name).trim().split(/\s+/)[0];
  return `Hello ${first},`;
}

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
  name,
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
    const resolvedName = await resolveUserName(email, name);
    const { subject: mailSubject, text: mailText, html } = await eventEmail({
      title: title || subject,
      greeting: greetingFor(resolvedName),
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

module.exports = { notifyUser, notifyMany, greetingFor, resolveUserName };
