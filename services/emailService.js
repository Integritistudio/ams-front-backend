const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const {
  passwordSetupEmail,
  passwordResetEmail,
  smtpTestEmail,
} = require('./emailTemplates');

const LOGO_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'integriti-logo.png'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'integriti-logo.png'),
];

function resolveLogoPath() {
  for (const p of LOGO_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function logoAttachment() {
  const filename = resolveLogoPath();
  if (!filename) return null;
  return {
    filename: 'integriti-logo.png',
    path: filename,
    cid: 'integriti-logo',
    contentDisposition: 'inline',
  };
}

let cachedTransport = null;
let cachedKey = '';
let smtpRowCache = null;
let smtpRowCacheAt = 0;
const SMTP_ROW_TTL_MS = 15000;

function publicSmtpRow(row) {
  if (!row) {
    return {
      enabled: false,
      host: '',
      port: 587,
      secure: false,
      username: '',
      password_set: false,
      from_name: 'Integriti IT Helpdesk',
      from_email: '',
    };
  }
  return {
    enabled: Boolean(row.enabled),
    host: row.host || '',
    port: Number(row.port || 587),
    secure: Boolean(row.secure),
    username: row.username || '',
    password_set: Boolean(row.password),
    from_name: row.from_name || 'Integriti IT Helpdesk',
    from_email: row.from_email || '',
    updated_at: row.updated_at || null,
  };
}

let ensuredSmtpRow = false;

async function ensureRow() {
  if (ensuredSmtpRow) return;
  await db.query(
    `INSERT INTO email_smtp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );
  ensuredSmtpRow = true;
}

async function getSmtpSettings() {
  const now = Date.now();
  if (smtpRowCache && now - smtpRowCacheAt < SMTP_ROW_TTL_MS) {
    return smtpRowCache;
  }
  await ensureRow();
  const result = await db.query(`SELECT * FROM email_smtp_settings WHERE id = 1`);
  smtpRowCache = result.rows[0] || null;
  smtpRowCacheAt = now;
  return smtpRowCache;
}

async function getPublicSmtpSettings() {
  return publicSmtpRow(await getSmtpSettings());
}

function invalidateTransportCache() {
  cachedTransport = null;
  cachedKey = '';
  smtpRowCache = null;
  smtpRowCacheAt = 0;
}

async function updateSmtpSettings(body = {}) {
  await ensureRow();
  const current = await getSmtpSettings();

  const host = body.host !== undefined ? String(body.host || '').trim() : (current?.host || '');
  const port = body.port !== undefined ? Number(body.port || 587) : Number(current?.port || 587);
  const secure = body.secure !== undefined ? Boolean(body.secure) : Boolean(current?.secure);
  const username = body.username !== undefined ? String(body.username || '').trim() : (current?.username || '');
  const fromName = body.from_name !== undefined ? String(body.from_name || '').trim() : (current?.from_name || 'Integriti IT Helpdesk');
  const fromEmail = body.from_email !== undefined ? String(body.from_email || '').trim() : (current?.from_email || '');

  let password = current?.password || null;
  if (body.password !== undefined && String(body.password).length > 0) {
    password = String(body.password);
  }
  if (body.clear_password === true) {
    password = null;
  }

  let enabled = body.enabled !== undefined ? Boolean(body.enabled) : Boolean(current?.enabled);
  // If credentials are complete and admin did not explicitly disable, enable sending
  if (body.enabled === undefined && host && username && password) {
    enabled = true;
  }

  const result = await db.query(
    `UPDATE email_smtp_settings SET
       enabled = $1,
       host = $2,
       port = $3,
       secure = $4,
       username = $5,
       password = $6,
       from_name = $7,
       from_email = $8,
       updated_at = NOW()
     WHERE id = 1
     RETURNING *`,
    [enabled, host || null, port, secure, username || null, password, fromName || null, fromEmail || null]
  );

  invalidateTransportCache();
  return publicSmtpRow(result.rows[0]);
}

async function buildTransporterFromSettings(row) {
  if (!row?.enabled || !row.host || !row.username || !row.password) {
    return null;
  }

  const key = JSON.stringify({
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password: row.password,
  });

  if (cachedTransport && cachedKey === key) {
    return cachedTransport;
  }

  const port = Number(row.port || 587);
  const secure = port === 465 ? true : Boolean(row.secure);

  cachedTransport = nodemailer.createTransport({
    host: row.host,
    port,
    secure,
    auth: {
      user: row.username,
      pass: row.password,
    },
    requireTLS: !secure,
    tls: {
      minVersion: 'TLSv1.2',
    },
  });
  cachedKey = key;
  return cachedTransport;
}

async function getTransporter() {
  const row = await getSmtpSettings();
  return buildTransporterFromSettings(row);
}

async function isSmtpConfigured() {
  const row = await getSmtpSettings();
  return Boolean(row?.enabled && row.host && row.username && row.password);
}

async function sendMail({ to, subject, text, html, attachments }) {
  const row = await getSmtpSettings();
  const transport = await buildTransporterFromSettings(row);
  const fromEmail = row?.from_email || row?.username || '';
  const fromName = row?.from_name || 'Integriti IT Helpdesk';
  const from = fromEmail ? `"${fromName}" <${fromEmail}>` : fromName;

  const inlineLogo = logoAttachment();
  const mailAttachments = [
    ...(attachments || []),
    ...(inlineLogo && String(html || '').includes('cid:integriti-logo') ? [inlineLogo] : []),
  ];

  if (!transport) {
    console.log('----- EMAIL (SMTP not configured in admin; logged only) -----');
    console.log({ to, subject, text, html, from, attachments: mailAttachments.map((a) => a.filename || a.cid) });
    console.log('-------------------------------------------------------------');
    return { delivered: false, logged: true };
  }

  await transport.sendMail({
    from,
    to,
    subject,
    text,
    html,
    attachments: mailAttachments.length ? mailAttachments : undefined,
  });
  return { delivered: true, logged: false };
}

async function sendPasswordSetupEmail(user, setupUrl) {
  const { subject, text, html } = await passwordSetupEmail(user, setupUrl);
  return sendMail({ to: user.email, subject, text, html });
}

async function sendPasswordResetEmail(user, resetUrl) {
  const { subject, text, html } = await passwordResetEmail(user, resetUrl);
  return sendMail({ to: user.email, subject, text, html });
}

async function sendTestEmail(toEmail) {
  const row = await getSmtpSettings();
  if (!row?.enabled) {
    const err = new Error('SMTP is saved but not enabled. Turn on “Enable SMTP sending” and save again.');
    err.status = 400;
    throw err;
  }
  const transport = await buildTransporterFromSettings(row);
  if (!transport) {
    const err = new Error('SMTP is not fully configured. Set host, username, and password.');
    err.status = 400;
    throw err;
  }
  const to = (toEmail || row.username || row.from_email || '').trim();
  if (!to) {
    const err = new Error('Provide a test recipient email');
    err.status = 400;
    throw err;
  }
  const fromEmail = row.from_email || row.username;
  const fromName = row.from_name || 'Integriti IT Helpdesk';
  let recipientName = null;
  try {
    const u = await db.query(`SELECT name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [to]);
    recipientName = u.rows[0]?.name || null;
  } catch (_e) {
    /* ignore */
  }
  const { subject, text, html } = await smtpTestEmail(to, recipientName);
  const inlineLogo = logoAttachment();
  try {
    await transport.verify();
    await transport.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      text,
      html,
      attachments: inlineLogo ? [inlineLogo] : undefined,
    });
  } catch (err) {
    const message = err.response || err.message || 'SMTP send failed';
    const e = new Error(message);
    e.status = 400;
    throw e;
  }
  return { delivered: true, to };
}

module.exports = {
  getSmtpSettings,
  getPublicSmtpSettings,
  updateSmtpSettings,
  invalidateTransportCache,
  getTransporter,
  isSmtpConfigured,
  sendMail,
  sendPasswordSetupEmail,
  sendPasswordResetEmail,
  sendTestEmail,
};
