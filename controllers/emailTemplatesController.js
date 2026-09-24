const db = require('../config/database');
const { addAuditLog, publicId } = require('../services/auditService');
const {
  ensureEmailEvents,
  listTemplates,
  listTriggers,
  setTriggers,
  previewRender,
  renderFullEmailPreview,
} = require('../services/emailTemplateService');
const { listEvents, getEvent, sampleVarsFor } = require('../services/emailEventCatalog');

function actor(req) {
  return { ...req.authz.user, role: req.authz.role };
}

async function findTemplate(idOrPublic) {
  const key = String(idOrPublic);
  const result = /^\d+$/.test(key)
    ? await db.query(`SELECT * FROM email_templates WHERE id = $1`, [key])
    : await db.query(`SELECT * FROM email_templates WHERE public_id = $1`, [key]);
  return result.rows[0] || null;
}

async function catalog(req, res, next) {
  try {
    await ensureEmailEvents();
    return res.json({ success: true, data: listEvents() });
  } catch (err) {
    return next(err);
  }
}

async function list(req, res, next) {
  try {
    const rows = await listTemplates();
    return res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    await ensureEmailEvents();
    const template = await findTemplate(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const meta = getEvent(template.event_key);
    return res.json({
      success: true,
      data: {
        ...template,
        event_name: meta?.name,
        event_description: meta?.description,
        variables: meta?.variables || [],
        sample_vars: sampleVarsFor(template.event_key),
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    await ensureEmailEvents();
    const { event_key, name, subject, body, status, use_custom } = req.body;
    if (!event_key) {
      return res.status(400).json({
        success: false,
        message: 'Templates are bound to system events. Pass event_key, or edit an existing event template.',
      });
    }
    const meta = getEvent(event_key);
    if (!meta) {
      return res.status(400).json({ success: false, message: `Unknown event_key: ${event_key}` });
    }
    const clash = await db.query(
      `SELECT id FROM email_templates WHERE event_key = $1 LIMIT 1`,
      [event_key]
    );
    if (clash.rows[0]) {
      return res.status(409).json({
        success: false,
        message: `A template already exists for ${event_key}. Edit that template instead.`,
      });
    }
    const pid = publicId('EML');
    const result = await db.query(
      `INSERT INTO email_templates (public_id, name, subject, body, status, event_key, use_custom)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        pid,
        name || meta.name,
        subject || meta.defaultSubject,
        body || meta.defaultBody,
        status || 'Active',
        event_key,
        Boolean(use_custom),
      ]
    );
    await addAuditLog({
      user: actor(req),
      action: 'Created Email Template',
      details: `Created template for ${event_key}`,
      targetId: result.rows[0].public_id,
    });
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    await ensureEmailEvents();
    const existing = await findTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const { name, subject, body, status, use_custom } = req.body;
    const result = await db.query(
      `UPDATE email_templates SET
         name = COALESCE($2, name),
         subject = COALESCE($3, subject),
         body = COALESCE($4, body),
         status = COALESCE($5, status),
         use_custom = COALESCE($6, use_custom),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        existing.id,
        name !== undefined ? name : null,
        subject !== undefined ? subject : null,
        body !== undefined ? body : null,
        status !== undefined ? status : null,
        use_custom !== undefined ? Boolean(use_custom) : null,
      ]
    );
    await addAuditLog({
      user: actor(req),
      action: 'Updated Email Template',
      details: `Updated template ${result.rows[0].event_key || result.rows[0].name} (use_custom=${result.rows[0].use_custom})`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    return next(err);
  }
}

async function resetDefaults(req, res, next) {
  try {
    await ensureEmailEvents();
    const existing = await findTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const meta = getEvent(existing.event_key);
    if (!meta) {
      return res.status(400).json({ success: false, message: 'Template is not linked to a known event' });
    }
    const result = await db.query(
      `UPDATE email_templates SET
         name = $2,
         subject = $3,
         body = $4,
         use_custom = FALSE,
         status = 'Active',
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [existing.id, meta.name, meta.defaultSubject, meta.defaultBody]
    );
    await addAuditLog({
      user: actor(req),
      action: 'Reset Email Template',
      details: `Reset template ${existing.event_key} to system defaults`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: result.rows[0], message: 'Restored system default copy. use_custom is off.' });
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const existing = await findTemplate(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    if (existing.event_key) {
      return res.status(400).json({
        success: false,
        message: 'System event templates cannot be deleted. Disable the trigger or turn off Use custom instead.',
      });
    }
    await db.query(`DELETE FROM email_templates WHERE id = $1`, [existing.id]);
    await addAuditLog({
      user: actor(req),
      action: 'Deleted Email Template',
      details: `Deleted template ${existing.name}`,
      targetId: existing.public_id,
    });
    return res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    return next(err);
  }
}

async function triggersList(req, res, next) {
  try {
    const rows = await listTriggers();
    return res.json({ success: true, data: rows });
  } catch (err) {
    return next(err);
  }
}

async function triggersUpdate(req, res, next) {
  try {
    const updates = Array.isArray(req.body?.triggers) ? req.body.triggers : req.body;
    if (!Array.isArray(updates)) {
      return res.status(400).json({ success: false, message: 'Body must include triggers: [{ event_key, enabled }]' });
    }
    const rows = await setTriggers(updates);
    await addAuditLog({
      user: actor(req),
      action: 'Updated Email Triggers',
      details: `Updated ${updates.length} email trigger(s)`,
      targetId: null,
    });
    return res.json({ success: true, data: rows, message: 'Email triggers saved.' });
  } catch (err) {
    return next(err);
  }
}

async function preview(req, res, next) {
  try {
    const { event_key, subject, body, vars, mode, name } = req.body || {};
    if (!event_key && !subject && !body) {
      return res.status(400).json({
        success: false,
        message: 'event_key (for full card) or subject/body is required',
      });
    }

    // Full branded card preview (preferred)
    if (event_key && (mode || req.query.full === '1' || req.body.full)) {
      const data = await renderFullEmailPreview({
        eventKey: event_key,
        mode: mode || 'outgoing',
        subject,
        body,
        name,
      });
      return res.json({ success: true, data });
    }

    // Legacy text-only preview
    if (!subject && !body) {
      return res.status(400).json({ success: false, message: 'subject or body is required' });
    }
    const rendered = previewRender(event_key, subject || '', body || '', vars || {});
    return res.json({ success: true, data: rendered });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

async function previewCard(req, res, next) {
  try {
    const eventKey = req.params.eventKey || req.body?.event_key;
    const mode = req.query.mode || req.body?.mode || 'outgoing';
    if (!eventKey) {
      return res.status(400).json({ success: false, message: 'event_key is required' });
    }
    const data = await renderFullEmailPreview({
      eventKey,
      mode,
      subject: req.body?.subject,
      body: req.body?.body,
      name: req.body?.name,
    });
    return res.json({ success: true, data });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return next(err);
  }
}

module.exports = {
  catalog,
  list,
  get,
  create,
  update,
  resetDefaults,
  remove,
  triggersList,
  triggersUpdate,
  preview,
  previewCard,
};
