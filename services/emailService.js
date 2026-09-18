const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || 'Integriti IT Helpdesk <noreply@integriti.io>';
  const transport = getTransporter();

  if (!transport) {
    console.log('----- EMAIL (SMTP not configured; logged only) -----');
    console.log({ to, subject, text, html });
    console.log('----------------------------------------------------');
    return { logged: true };
  }

  return transport.sendMail({ from, to, subject, text, html });
}

async function sendPasswordSetupEmail(user, setupUrl) {
  const subject = 'Set up your Integriti IT Helpdesk password';
  const text = `Hello ${user.name},\n\nAn administrator requested that you set up your password.\nOpen this link (valid for a limited time):\n${setupUrl}\n\nIf you did not expect this email, contact IT Support.\n`;
  const html = `<p>Hello ${user.name},</p><p>An administrator requested that you set up your password.</p><p><a href="${setupUrl}">Set your password</a></p><p>This link expires soon. If you did not expect this email, contact IT Support.</p>`;
  return sendMail({ to: user.email, subject, text, html });
}

async function sendPasswordResetEmail(user, resetUrl) {
  const subject = 'Reset your Integriti IT Helpdesk password';
  const text = `Hello ${user.name},\n\nUse this link to reset your password:\n${resetUrl}\n\nIf you did not request this, ignore this email.\n`;
  const html = `<p>Hello ${user.name},</p><p><a href="${resetUrl}">Reset your password</a></p><p>If you did not request this, ignore this email.</p>`;
  return sendMail({ to: user.email, subject, text, html });
}

module.exports = {
  sendMail,
  sendPasswordSetupEmail,
  sendPasswordResetEmail,
};
