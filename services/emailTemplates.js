/**
 * Branded email layouts — portal Settings colors + rich detail tables.
 * Table-based for Outlook / Microsoft 365 compatibility.
 */

const db = require('../config/database');
const { detailsToPlainText } = require('./emailDetails');

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

/** Pick white or dark text for contrast on a hex background. */
function contrastOn(hex) {
  const h = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#0f172a' : '#ffffff';
}

async function getPortalBranding() {
  try {
    const result = await db.query(
      `SELECT logo_url, color_primary, color_accent, color_text
       FROM portal_settings WHERE id = 1`
    );
    const row = result.rows[0] || {};
    const portal = portalBaseUrl();
    const primary = row.color_primary || '#2563eb';
    const useCid = !row.logo_url;
    return {
      logoUrl: row.logo_url || 'cid:integriti-logo',
      useInlineLogo: useCid,
      primary,
      accent: row.color_accent || '#06b6d4',
      headerText: contrastOn(primary),
      text: row.color_text || '#1e293b',
      muted: '#64748b',
      border: '#e2e8f0',
      bg: '#f1f5f9',
      card: '#ffffff',
      portal,
    };
  } catch (_e) {
    const primary = '#2563eb';
    return {
      logoUrl: 'cid:integriti-logo',
      useInlineLogo: true,
      primary,
      accent: '#06b6d4',
      headerText: '#ffffff',
      text: '#1e293b',
      muted: '#64748b',
      border: '#e2e8f0',
      bg: '#f1f5f9',
      card: '#ffffff',
      portal: portalBaseUrl(),
    };
  }
}

function detailsTableHtml(brand, details) {
  if (!details?.length) return '';
  const rowsHtml = details
    .map((d, i) => {
      const bg = i % 2 === 0 ? '#f8fafc' : '#ffffff';
      return `
        <tr>
          <td style="padding:8px 10px;border:1px solid ${brand.border};font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;color:${brand.text};width:38%;background:${bg};vertical-align:top;">
            ${escapeHtml(d.label)}
          </td>
          <td style="padding:8px 10px;border:1px solid ${brand.border};font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${brand.muted};background:${bg};vertical-align:top;word-break:break-word;">
            ${escapeHtml(d.value).replace(/\n/g, '<br/>')}
          </td>
        </tr>`;
    })
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 6px;border-collapse:collapse;">
      <tr>
        <td colspan="2" style="padding:0 0 8px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:${brand.text};">
          Details
        </td>
      </tr>
      ${rowsHtml}
    </table>`;
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
  const headerText = brand.headerText || contrastOn(primary);
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
        <td style="padding: 8px 0 22px;text-align:left;">
          <a href="${safeCtaUrl}"
             style="display:inline-block;background-color:${primary};color:#ffffff;text-decoration:none;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;padding:12px 22px;border-radius:6px;">
            ${safeCtaLabel || 'Continue'}
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 0 18px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${brand.muted};word-break:break-all;text-align:left;">
          Or open this link:<br/>
          <a href="${safeCtaUrl}" style="color:${primary};text-decoration:underline;">${safeCtaUrl}</a>
        </td>
      </tr>`
    : '';

  const noteBlock = safeNote
    ? `
      <tr>
        <td style="padding:0 0 6px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.55;color:${brand.muted};border-top:1px solid ${brand.border};padding-top:16px;text-align:left;">
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
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;background:${brand.card};border:1px solid ${brand.border};border-radius:8px;overflow:hidden;">
          <!-- Header uses portal primary color from Settings -->
          <tr>
            <td align="center" style="padding:20px 32px;background-color:${primary};text-align:center;">
              <img src="${safeLogo}" alt="Integriti" width="70" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;height:auto;max-width:70px;" />
              <div style="margin-top:10px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;color:${headerText};text-align:center;">
                IT Service Desk
              </div>
            </td>
          </tr>
          <!-- Accent underline -->
          <tr>
            <td style="height:3px;line-height:3px;font-size:0;background-color:${brand.accent || primary};">&nbsp;</td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:28px 32px 8px;text-align:left;">
              <h1 style="margin:0 0 16px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:20px;line-height:1.35;color:${brand.text};font-weight:700;text-align:left;">
                ${safeTitle}
              </h1>
              <p style="margin:0 0 12px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${brand.text};text-align:left;">
                ${safeGreeting}
              </p>
              <div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:${brand.muted};text-align:left;">
                ${bodyHtml}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:4px 32px 24px;text-align:left;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${ctaBlock}
                ${noteBlock}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:18px 32px;border-top:1px solid ${brand.border};background:#fafbfc;text-align:center;">
              <p style="margin:0 0 6px;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${brand.muted};text-align:center;">
                <a href="${safePortal}" style="color:${primary};text-decoration:none;font-weight:600;">Open Service Desk Portal</a>
              </p>
              <p style="margin:0;font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#94a3b8;text-align:center;">
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
  const subject = 'Set up your IT Service Desk password';
  const details = [
    { label: 'Account name', value: name },
    { label: 'Account email', value: user?.email || '' },
    { label: 'Link validity', value: '24 hours from send time' },
    { label: 'Action required', value: 'Choose a secure password to activate sign-in' },
  ].filter((d) => d.value);
  const text = `Hello ${name},\n\nAn administrator invited you to set up your IT Service Desk password.\n\n${detailsToPlainText(details)}\n\nOpen this link (valid for a limited time):\n${setupUrl}\n\nIf you did not expect this email, contact IT Support.\n`;
  const html = renderBrandedEmail({
    brand,
    preheader: 'Set up your IT Service Desk password.',
    title: 'Set up your password',
    greeting: `Hello ${name},`,
    bodyHtml: `
      <p style="margin:0 0 12px;color:${brand.muted};">An administrator created your account on the IT Service Desk portal. Use the details below, then set your password.</p>
      ${detailsTableHtml(brand, details)}
      <p style="margin:14px 0 0;color:${brand.muted};">This link expires in <strong style="color:${brand.text};">24 hours</strong>.</p>
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
  const subject = 'Reset your IT Service Desk password';
  const details = [
    { label: 'Account name', value: name },
    { label: 'Account email', value: user?.email || '' },
    { label: 'Request type', value: 'Password reset' },
  ].filter((d) => d.value);
  const text = `Hello ${name},\n\nUse this link to reset your IT Service Desk password:\n${resetUrl}\n\n${detailsToPlainText(details)}\n\nIf you did not request this, ignore this email.\n`;
  const html = renderBrandedEmail({
    brand,
    preheader: 'Reset your IT Service Desk password.',
    title: 'Reset your password',
    greeting: `Hello ${name},`,
    bodyHtml: `
      <p style="margin:0 0 12px;color:${brand.muted};">We received a request to reset the password for your IT Service Desk account.</p>
      ${detailsTableHtml(brand, details)}
      <p style="margin:14px 0 0;color:${brand.muted};">Use the button below to choose a new password. The link is valid for a limited time.</p>
    `,
    ctaLabel: 'Reset my password',
    ctaUrl: resetUrl,
    note: 'If you did not request this, you can safely ignore this email. Your password will remain unchanged.',
  });
  return { subject, text, html };
}

async function smtpTestEmail(to, name) {
  const brand = await getPortalBranding();
  const first = name ? String(name).trim().split(/\s+/)[0] : null;
  const greeting = first ? `Hello ${first},` : 'Hello,';
  const subject = 'IT Service Desk — SMTP test successful';
  const details = [
    { label: 'Delivered to', value: to },
    { label: 'Header color (Settings primary)', value: brand.primary },
    { label: 'Accent color', value: brand.accent },
    { label: 'Result', value: 'Outgoing SMTP is working' },
  ];
  const text = `SMTP test successful.\n\n${detailsToPlainText(details)}\n`;
  const html = renderBrandedEmail({
    brand,
    preheader: 'SMTP configuration verified.',
    title: 'SMTP test successful',
    greeting,
    bodyHtml: `
      <p style="margin:0 0 12px;color:${brand.muted};">This confirms your outgoing email settings in IT Service Desk are working. The card header above uses your portal <strong style="color:${brand.text};">Primary</strong> color from Settings.</p>
      ${detailsTableHtml(brand, details)}
    `,
  });
  return { subject, text, html };
}

/**
 * Generic event email (tickets, approvals, assets, etc.)
 * @param {Array<{label:string,value:string}>} [details]
 */
async function eventEmail({
  subject,
  title,
  greeting = 'Hello,',
  bodyText,
  details = [],
  ctaLabel,
  ctaUrl,
  type = 'info',
}) {
  const brand = await getPortalBranding();
  const portal = portalBaseUrl();
  const safeBody = escapeHtml(bodyText || '').replace(/\n/g, '<br/>');
  const detailBlock = detailsTableHtml(brand, details);
  const html = renderBrandedEmail({
    brand,
    preheader: subject || title,
    title: title || subject || 'IT Service Desk update',
    greeting,
    bodyHtml: `
      ${bodyText ? `<p style="margin:0 0 12px;color:${brand.muted};">${safeBody}</p>` : ''}
      ${detailBlock}
    `,
    ctaLabel: ctaLabel || 'Open Service Desk Portal',
    ctaUrl: ctaUrl || portal,
    note:
      type === 'warning'
        ? 'Please review this item in the portal as soon as possible.'
        : type === 'error'
          ? 'Please review this update and take any required action in the portal.'
          : undefined,
  });

  const detailText = detailsToPlainText(details);
  const text = [
    title || subject,
    '',
    bodyText || '',
    detailText ? `\n--- Details ---\n${detailText}` : '',
    '',
    `Open portal: ${ctaUrl || portal}`,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return { subject: subject || title, text, html };
}

module.exports = {
  escapeHtml,
  getPortalBranding,
  renderBrandedEmail,
  detailsTableHtml,
  passwordSetupEmail,
  passwordResetEmail,
  smtpTestEmail,
  eventEmail,
};
