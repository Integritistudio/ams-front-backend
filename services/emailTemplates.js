/**
 * Clean Integriti email layouts — logo + portal primary colors (no colorful banner).
 * Table-based for Outlook / Microsoft 365 compatibility.
 */

const db = require('../config/database');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function portalBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

async function getPortalBranding() {
  try {
    const result = await db.query(
      `SELECT logo_url, color_primary, color_accent, color_text
       FROM portal_settings WHERE id = 1`
    );
    const row = result.rows[0] || {};
    const portal = portalBaseUrl();
    return {
      logoUrl: row.logo_url || `${portal}/integriti-logo.png`,
      primary: row.color_primary || '#2563eb',
      accent: row.color_accent || '#06b6d4',
      text: '#1e293b',
      muted: '#64748b',
      border: '#e2e8f0',
      bg: '#f1f5f9',
      card: '#ffffff',
    };
  } catch (_e) {
    const portal = portalBaseUrl();
    return {
      logoUrl: `${portal}/integriti-logo.png`,
      primary: '#2563eb',
      accent: '#06b6d4',
      text: '#1e293b',
      muted: '#64748b',
      border: '#e2e8f0',
      bg: '#f1f5f9',
      card: '#ffffff',
    };
  }
}

/**
 * @param {object} opts
 * @param {object} opts.brand
 * @param {string} opts.preheader
 * @param {string} opts.title
 * @param {string} opts.greeting
 * @param {string} opts.bodyHtml
 * @param {string} [opts.ctaLabel]
 * @param {string} [opts.ctaUrl]
 * @param {string} [opts.note]
 */
function renderBrandedEmail({
  brand,
  preheader = '',
  title,
  greeting,
  bodyHtml,
  ctaLabel,
  ctaUrl,
  note,
}) {
  const year = new Date().getFullYear();
  const portal = portalBaseUrl();
  const primary = brand.primary || '#2563eb';
  const logoUrl = brand.logoUrl;

  const safeTitle = escapeHtml(title);
  const safeGreeting = escapeHtml(greeting);
  const safePreheader = escapeHtml(preheader);
  const safeNote = note ? escapeHtml(note) : '';
  const safeCtaLabel = ctaLabel ? escapeHtml(ctaLabel) : '';
  const safeCtaUrl = ctaUrl ? escapeHtml(ctaUrl) : '';
  const safeLogo = escapeHtml(logoUrl);
  const safePortal = escapeHtml(portal);

  const ctaBlock = ctaUrl
    ? `
      <tr>
        <td style="padding: 8px 0 22px;">
          <a href="${safeCtaUrl}"
             style="display:inline-block;background-color:${primary};color:#ffffff;text-decoration:none;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;padding:12px 22px;border-radius:6px;">
            ${safeCtaLabel || 'Continue'}
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 0 18px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${brand.muted};word-break:break-all;">
          Or open this link:<br/>
          <a href="${safeCtaUrl}" style="color:${primary};text-decoration:underline;">${safeCtaUrl}</a>
        </td>
      </tr>`
    : '';

  const noteBlock = safeNote
    ? `
      <tr>
        <td style="padding:0 0 6px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.55;color:${brand.muted};border-top:1px solid ${brand.border};padding-top:16px;">
          ${safeNote}
        </td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:${brand.bg};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safePreheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${brand.bg};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:${brand.card};border:1px solid ${brand.border};border-radius:8px;">
          <!-- Logo -->
          <tr>
            <td style="padding:28px 32px 16px;border-bottom:1px solid ${brand.border};">
              <img src="${safeLogo}" alt="Integriti" width="140" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:140px;" />
              <div style="margin-top:10px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;color:${brand.muted};">
                IT Helpdesk &amp; Asset Portal
              </div>
            </td>
          </tr>
          <!-- Primary accent line (portal primary color) -->
          <tr>
            <td style="height:3px;line-height:3px;font-size:0;background-color:${primary};">&nbsp;</td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:28px 32px 8px;">
              <h1 style="margin:0 0 16px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:20px;line-height:1.35;color:${brand.text};font-weight:700;">
                ${safeTitle}
              </h1>
              <p style="margin:0 0 12px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${brand.text};">
                ${safeGreeting}
              </p>
              <div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:${brand.muted};">
                ${bodyHtml}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:4px 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${ctaBlock}
                ${noteBlock}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:18px 32px;border-top:1px solid ${brand.border};background:#fafbfc;">
              <p style="margin:0 0 6px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${brand.muted};">
                <a href="${safePortal}" style="color:${primary};text-decoration:none;font-weight:600;">Open Helpdesk Portal</a>
              </p>
              <p style="margin:0;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#94a3b8;">
                © ${year} Integriti · Automated message — please do not reply
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function passwordSetupEmail(user, setupUrl) {
  const brand = await getPortalBranding();
  const name = user?.name || 'there';
  const subject = 'Set up your Integriti IT Helpdesk password';
  const text = `Hello ${name},\n\nAn administrator invited you to set up your Integriti IT Helpdesk password.\n\nOpen this link (valid for a limited time):\n${setupUrl}\n\nIf you did not expect this email, contact IT Support.\n`;
  const html = renderBrandedEmail({
    brand,
    preheader: 'Set up your Integriti Helpdesk password.',
    title: 'Set up your password',
    greeting: `Hello ${name},`,
    bodyHtml: `
      <p style="margin:0 0 12px;color:${brand.muted};">An administrator created your account on the Integriti IT Helpdesk portal.</p>
      <p style="margin:0 0 12px;color:${brand.muted};">Use the button below to choose a secure password. This link expires in <strong style="color:${brand.text};">24 hours</strong>.</p>
    `,
    ctaLabel: 'Set my password',
    ctaUrl: setupUrl,
    note: 'If you did not expect this invitation, ignore this email or contact IT Support.',
  });
  return { subject, text, html };
}

async function passwordResetEmail(user, resetUrl) {
  const brand = await getPortalBranding();
  const name = user?.name || 'there';
  const subject = 'Reset your Integriti IT Helpdesk password';
  const text = `Hello ${name},\n\nUse this link to reset your Integriti IT Helpdesk password:\n${resetUrl}\n\nIf you did not request this, ignore this email.\n`;
  const html = renderBrandedEmail({
    brand,
    preheader: 'Reset your Integriti Helpdesk password.',
    title: 'Reset your password',
    greeting: `Hello ${name},`,
    bodyHtml: `
      <p style="margin:0 0 12px;color:${brand.muted};">We received a request to reset the password for your Integriti IT Helpdesk account.</p>
      <p style="margin:0 0 12px;color:${brand.muted};">Use the button below to choose a new password. The link is valid for a limited time.</p>
    `,
    ctaLabel: 'Reset my password',
    ctaUrl: resetUrl,
    note: 'If you did not request this, you can safely ignore this email. Your password will remain unchanged.',
  });
  return { subject, text, html };
}

async function smtpTestEmail(to) {
  const brand = await getPortalBranding();
  const subject = 'Integriti Helpdesk — SMTP test successful';
  const text = `SMTP test successful.\n\nOutgoing email is working for Integriti IT Helpdesk.\nRecipient: ${to}\n`;
  const html = renderBrandedEmail({
    brand,
    preheader: 'SMTP configuration verified.',
    title: 'SMTP test successful',
    greeting: 'Hello,',
    bodyHtml: `
      <p style="margin:0 0 12px;color:${brand.muted};">This confirms your outgoing email settings in Integriti IT Helpdesk are working.</p>
      <p style="margin:0;color:${brand.muted};"><strong style="color:${brand.text};">Delivered to:</strong> ${escapeHtml(to)}</p>
    `,
  });
  return { subject, text, html };
}

/**
 * Generic event email (tickets, approvals, assets, etc.)
 */
async function eventEmail({
  subject,
  title,
  greeting = 'Hello,',
  bodyText,
  ctaLabel,
  ctaUrl,
  type = 'info',
}) {
  const brand = await getPortalBranding();
  const portal = portalBaseUrl();
  const safeBody = escapeHtml(bodyText || '').replace(/\n/g, '<br/>');
  const html = renderBrandedEmail({
    brand,
    preheader: subject || title,
    title: title || subject || 'Integriti Helpdesk update',
    greeting,
    bodyHtml: `<p style="margin:0 0 12px;color:${brand.muted};">${safeBody}</p>`,
    ctaLabel: ctaLabel || 'Open Helpdesk Portal',
    ctaUrl: ctaUrl || portal,
    note: type === 'warning'
      ? 'Please review this item in the portal as soon as possible.'
      : undefined,
  });
  const text = `${title || subject}\n\n${bodyText || ''}\n\nOpen portal: ${ctaUrl || portal}\n`;
  return { subject: subject || title, text, html };
}

module.exports = {
  escapeHtml,
  getPortalBranding,
  renderBrandedEmail,
  passwordSetupEmail,
  passwordResetEmail,
  smtpTestEmail,
  eventEmail,
};
