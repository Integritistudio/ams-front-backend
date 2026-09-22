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

/** Send SMTP in background so CRUD APIs are not blocked by mail latency. */
function sendEmailInBackground(payload) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        const resolvedName = await resolveUserName(payload.email, payload.name);
        const { subject: mailSubject, text: mailText, html } = await eventEmail({
          title: payload.title || payload.subject,
          greeting: greetingFor(resolvedName),
          bodyText: payload.text,
          subject: payload.subject,
          ctaLabel: payload.ctaLabel,
          ctaUrl: payload.ctaUrl,
          type: payload.type,
        });
        await emailService.sendMail({
          to: payload.email,
          subject: mailSubject,
          text: mailText,
          html,
        });
      })
      .catch((err) => {
        console.error('notifyUser background email failed:', err.message);
      });
  });
}

/**
 * Create in-app notification immediately; SMTP email is queued (non-blocking).
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

  sendEmailInBackground({
    email,
    subject,
    text,
    title,
    type,
    ctaLabel,
    ctaUrl,
    name,
  });

  return { notified: true, emailed: 'queued' };
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
