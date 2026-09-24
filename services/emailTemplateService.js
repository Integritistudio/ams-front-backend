const db = require('../config/database');
const { publicId } = require('./auditService');
const { EVENTS, getEvent, sampleVarsFor } = require('./emailEventCatalog');

let ensuredEventCount = 0;

function applyTemplate(str, vars = {}) {
  return String(str ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const val = vars[key];
    return val === null || val === undefined ? '' : String(val);
  });
}

async function ensureEmailEvents() {
  // Re-run seed when catalog grows (e.g. new event keys after deploy) without full restart quirks
  if (ensuredEventCount === EVENTS.length && ensuredEventCount > 0) return;
  await db.query(`
    ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS event_key VARCHAR(80);
    ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS use_custom BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_triggers (
      event_key VARCHAR(80) PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Unique event_key among non-null rows
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS email_templates_event_key_uidx
      ON email_templates (event_key)
      WHERE event_key IS NOT NULL;
  `);

  for (const ev of EVENTS) {
    await db.query(
      `INSERT INTO email_triggers (event_key, enabled)
       VALUES ($1, TRUE)
       ON CONFLICT (event_key) DO NOTHING`,
      [ev.key]
    );

    const existing = await db.query(
      `SELECT id FROM email_templates WHERE event_key = $1 LIMIT 1`,
      [ev.key]
    );
    if (!existing.rows[0]) {
      // Migrate legacy seed row if name matches loosely
      const legacy = await db.query(
        `SELECT id FROM email_templates
         WHERE event_key IS NULL AND (
           LOWER(name) LIKE '%ticket%solved%' OR LOWER(name) LIKE '%resolved%'
         )
         LIMIT 1`
      );
      if (legacy.rows[0] && ev.key === 'ticket.status_changed') {
        await db.query(
          `UPDATE email_templates SET
             event_key = $2,
             name = $3,
             subject = $4,
             body = $5,
             use_custom = FALSE,
             status = 'Active',
             updated_at = NOW()
           WHERE id = $1`,
          [legacy.rows[0].id, ev.key, ev.name, ev.defaultSubject, ev.defaultBody]
        );
      } else {
        await db.query(
          `INSERT INTO email_templates (public_id, name, subject, body, status, event_key, use_custom)
           VALUES ($1, $2, $3, $4, 'Active', $5, FALSE)`,
          [publicId('EML'), ev.name, ev.defaultSubject, ev.defaultBody, ev.key]
        );
      }
    }
  }

  ensuredEventCount = EVENTS.length;
}

async function isTriggerEnabled(eventKey) {
  if (!eventKey) return true;
  await ensureEmailEvents();
  const result = await db.query(
    `SELECT enabled FROM email_triggers WHERE event_key = $1`,
    [eventKey]
  );
  if (!result.rows[0]) return true;
  return Boolean(result.rows[0].enabled);
}

async function getTemplateByEvent(eventKey) {
  if (!eventKey) return null;
  await ensureEmailEvents();
  const result = await db.query(
    `SELECT * FROM email_templates WHERE event_key = $1 LIMIT 1`,
    [eventKey]
  );
  return result.rows[0] || null;
}

async function listTemplates() {
  await ensureEmailEvents();
  const result = await db.query(
    `SELECT t.*,
            COALESCE(tr.enabled, TRUE) AS trigger_enabled
     FROM email_templates t
     LEFT JOIN email_triggers tr ON tr.event_key = t.event_key
     WHERE t.event_key IS NOT NULL
     ORDER BY t.name ASC`
  );
  return result.rows.map((row) => {
    const meta = getEvent(row.event_key);
    return {
      ...row,
      event_name: meta?.name || row.event_key,
      event_description: meta?.description || '',
      event_category: meta?.category || '',
      variables: meta?.variables || [],
    };
  });
}

async function listTriggers() {
  await ensureEmailEvents();
  const result = await db.query(
    `SELECT event_key, enabled, updated_at FROM email_triggers ORDER BY event_key ASC`
  );
  return result.rows.map((row) => {
    const meta = getEvent(row.event_key);
    return {
      event_key: row.event_key,
      enabled: Boolean(row.enabled),
      updated_at: row.updated_at,
      name: meta?.name || row.event_key,
      description: meta?.description || '',
      category: meta?.category || '',
    };
  });
}

async function setTriggers(updates = []) {
  await ensureEmailEvents();
  for (const u of updates) {
    if (!u?.event_key) continue;
    await db.query(
      `INSERT INTO email_triggers (event_key, enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (event_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [u.event_key, Boolean(u.enabled)]
    );
  }
  return listTriggers();
}

/**
 * Resolve subject/title/body for outbound email.
 * Returns null when the trigger is disabled (skip SMTP).
 */
async function resolveCustomContent({ event, subject, title, bodyText, vars = {} }) {
  if (event) {
    const enabled = await isTriggerEnabled(event);
    if (!enabled) return { skipEmail: true };
  }

  const tpl = event ? await getTemplateByEvent(event) : null;
  const portal = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
  const merged = { portalUrl: portal, ...vars };

  if (tpl && tpl.use_custom && String(tpl.status || '').toLowerCase() === 'active') {
    return {
      skipEmail: false,
      subject: applyTemplate(tpl.subject, merged) || subject,
      title: applyTemplate(tpl.name, merged) || title || subject,
      bodyText: applyTemplate(tpl.body, merged) || bodyText,
      usedCustom: true,
    };
  }

  return {
    skipEmail: false,
    subject,
    title,
    bodyText,
    usedCustom: false,
  };
}

function previewRender(eventKey, subject, body, vars) {
  const samples = { ...sampleVarsFor(eventKey), ...(vars || {}) };
  return {
    subject: applyTemplate(subject, samples),
    body: applyTemplate(body, samples),
    vars: samples,
  };
}

/** Build sample detail-table rows from sample vars for preview emails. */
function sampleDetailsFor(eventKey, samples = {}) {
  const s = samples;
  const pairsByPrefix = {
    ticket: [
      ['Ticket ID', s.ticketId],
      ['Subject', s.subject],
      ['Status', s.status],
      ['Priority', s.priority],
      ['Category', s.category],
      ['Department', s.department],
      ['Requester', s.requesterName],
      ['Requester email', s.requesterEmail],
      ['Assigned to', s.assignedTo],
      ['SLA due', s.slaDue],
      ['Description', s.description],
      ['Hold reason', s.holdReason],
      ['Latest update', s.latestUpdate],
      ['Reply from', s.repliedBy],
      ['Reply message', s.replyMessage],
    ],
    requisition: [
      ['Request ID', s.requestId],
      ['Item / asset', s.item],
      ['Type', s.type],
      ['Status', s.status],
      ['Urgency', s.urgency],
      ['Project', s.project],
      ['Department', s.department],
      ['Requester', s.requesterName],
      ['Requester email', s.requesterEmail],
      ['Approver / signer', s.approverName],
      ['Executive Priority', s.executivePriority],
      ['Justification', s.justification],
      ['Actioned by', s.actionedBy],
      ['Hold reason', s.holdReason],
      ['Rejection reason', s.rejectReason],
      ['Procurement ID', s.procurementId],
      ['Vendor', s.vendor],
      ['Cost', s.cost],
    ],
    asset: [
      ['Asset ID', s.assetId],
      ['Asset code', s.assetCode],
      ['Asset name', s.assetName],
      ['Category', s.category],
      ['Brand', s.brand],
      ['Serial number', s.serialNumber],
      ['Assigned date', s.assignedDate],
      ['Note', s.note],
      ['Assigned by', s.assignedBy],
    ],
    user: [
      ['Name', s.name],
      ['Email', s.email],
      ['Department', s.department],
      ['Designation', s.designation],
      ['Role', s.roleName],
      ['Status', s.status],
      ['Changed fields', s.changedFields],
      ['Kind', s.kind],
      ['Previous holder', s.previousHolder],
      ['New holder', s.newHolder],
      ['Pending work moved', s.pendingMoved],
    ],
    auth: [
      ['Account name', s.name],
      ['Account email', s.email],
      ['Link validity', s.linkValidity],
    ],
  };

  let bucket = 'ticket';
  if (String(eventKey || '').startsWith('requisition.')) bucket = 'requisition';
  else if (String(eventKey || '').startsWith('asset.')) bucket = 'asset';
  else if (String(eventKey || '').startsWith('user.')) bucket = 'user';
  else if (String(eventKey || '').startsWith('auth.')) bucket = 'auth';

  return (pairsByPrefix[bucket] || [])
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([label, value]) => ({ label, value: String(value) }));
}

/**
 * Full branded HTML preview (same card users receive).
 * mode: 'system' | 'custom' | 'outgoing'
 *  - system  = catalog default copy
 *  - custom  = saved/draft custom subject+body (even if use_custom is off)
 *  - outgoing = what is actually sent (custom if use_custom+Active, else system)
 */
async function renderFullEmailPreview({
  eventKey,
  mode = 'outgoing',
  subject: draftSubject,
  body: draftBody,
  name: draftName,
} = {}) {
  const { eventEmail } = require('./emailTemplates');
  const meta = getEvent(eventKey);
  if (!meta) {
    const err = new Error(`Unknown event: ${eventKey}`);
    err.status = 400;
    throw err;
  }

  await ensureEmailEvents();
  const tpl = await getTemplateByEvent(eventKey);
  const samples = sampleVarsFor(eventKey);
  const details = sampleDetailsFor(eventKey, samples);
  const greetingName =
    samples.requesterName || samples.name || samples.assignedBy || 'there';
  const first = String(greetingName).trim().split(/\s+/)[0] || 'there';

  const useCustomOutgoing =
    Boolean(tpl?.use_custom) && String(tpl?.status || '').toLowerCase() === 'active';

  let resolvedMode = mode;
  if (mode === 'outgoing') {
    resolvedMode = useCustomOutgoing ? 'custom' : 'system';
  }

  let subject;
  let title;
  let bodyText;
  let sourceLabel;

  if (resolvedMode === 'custom') {
    subject = applyTemplate(draftSubject != null ? draftSubject : tpl?.subject || meta.defaultSubject, samples);
    title = applyTemplate(draftName != null ? draftName : tpl?.name || meta.name, samples);
    bodyText = applyTemplate(draftBody != null ? draftBody : tpl?.body || meta.defaultBody, samples);
    sourceLabel = useCustomOutgoing
      ? 'Outgoing email (custom template active)'
      : 'Custom template preview (not active yet — turn on “Use custom” to send this)';
  } else {
    subject = applyTemplate(meta.defaultSubject, samples);
    title = meta.name;
    bodyText = applyTemplate(meta.defaultBody, samples);
    sourceLabel = 'System default email';
  }

  const type =
    /reject|error|fail/i.test(eventKey) || /reject/i.test(subject)
      ? 'error'
      : /pending|assign|action|warning|hold|transfer/i.test(eventKey)
        ? 'warning'
        : 'info';

  const ctaLabel =
    eventKey.startsWith('ticket.')
      ? 'View tickets'
      : eventKey.startsWith('requisition.')
        ? /pending|approv/i.test(eventKey)
          ? 'Open pending approvals'
          : 'View requisition'
        : eventKey.startsWith('asset.')
          ? 'View my assets'
          : eventKey.startsWith('auth.')
            ? eventKey.includes('reset')
              ? 'Reset my password'
              : 'Set my password'
            : 'Open Service Desk Portal';

  const ctaUrl =
    eventKey.startsWith('auth.password_setup')
      ? samples.setupUrl
      : eventKey.startsWith('auth.password_reset')
        ? samples.resetUrl
        : samples.portalUrl;

  const mail = await eventEmail({
    subject,
    title,
    greeting: `Hello ${first},`,
    bodyText,
    details,
    ctaLabel,
    ctaUrl,
    type,
  });

  return {
    mode: resolvedMode,
    requestedMode: mode,
    use_custom_active: useCustomOutgoing,
    source_label: sourceLabel,
    event_key: eventKey,
    event_name: meta.name,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    vars: samples,
  };
}

module.exports = {
  ensureEmailEvents,
  isTriggerEnabled,
  getTemplateByEvent,
  listTemplates,
  listTriggers,
  setTriggers,
  resolveCustomContent,
  applyTemplate,
  previewRender,
  sampleDetailsFor,
  renderFullEmailPreview,
};
