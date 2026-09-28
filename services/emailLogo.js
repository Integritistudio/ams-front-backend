/**
 * Shared logo resolution for branded emails (CID inline + preview data URI).
 */
const fs = require('fs');
const path = require('path');

const LOGO_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'integriti-logo.png'),
  path.join(__dirname, '..', '..', 'frontend', 'public', 'integriti-logo.png'),
];

const CID = 'integriti-logo';

function resolveLogoPath() {
  for (const p of LOGO_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Nodemailer inline attachment (Outlook / Gmail compatible). */
function logoAttachment() {
  const filename = resolveLogoPath();
  if (!filename) return null;
  return {
    filename: 'integriti-logo.png',
    path: filename,
    cid: CID,
    contentType: 'image/png',
    contentDisposition: 'inline',
  };
}

/** Browser-safe logo for email-card preview iframes (cid: does not work in browsers). */
function logoDataUri() {
  const filename = resolveLogoPath();
  if (!filename) return null;
  try {
    const buf = fs.readFileSync(filename);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (_e) {
    return null;
  }
}

/**
 * Pick logo URL for HTML.
 * - Prefer cid: when local file exists (reliable in real mail clients + attachment).
 * - Else use absolute https logo_url from Settings.
 * - Else absolute portal /integriti-logo.png (preview / last resort).
 */
function resolveEmailLogoUrl({ logoUrlFromDb, portalBase }) {
  const portal = String(portalBase || '').replace(/\/$/, '');
  const fileExists = Boolean(resolveLogoPath());

  if (fileExists) {
    return { logoUrl: `cid:${CID}`, useInlineLogo: true };
  }

  const raw = String(logoUrlFromDb || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    return { logoUrl: raw, useInlineLogo: false };
  }
  if (raw.startsWith('/') && portal) {
    return { logoUrl: `${portal}${raw}`, useInlineLogo: false };
  }
  if (portal) {
    return { logoUrl: `${portal}/integriti-logo.png`, useInlineLogo: false };
  }
  return { logoUrl: `cid:${CID}`, useInlineLogo: true };
}

/** Rewrite cid: references to a data URI so HTML previews render the logo. */
function rewriteLogoForPreview(html) {
  if (!html) return html;
  const dataUri = logoDataUri();
  if (!dataUri) return html;
  return String(html).replace(/cid:integriti-logo/gi, dataUri);
}

module.exports = {
  CID,
  resolveLogoPath,
  logoAttachment,
  logoDataUri,
  resolveEmailLogoUrl,
  rewriteLogoForPreview,
};
