const db = require('../config/database');

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-3.6-flash',
};

const DEPRECATED_GEMINI_MODELS = {
  'gemini-2.0-flash': 'gemini-3.6-flash',
  'gemini-2.0-flash-lite': 'gemini-3.6-flash',
  'gemini-1.5-flash': 'gemini-3.6-flash',
  'gemini-1.5-pro': 'gemini-3.6-flash',
};

function normalizeGeminiModel(model) {
  const m = String(model || '').trim();
  if (!m) return DEFAULT_MODELS.gemini;
  return DEPRECATED_GEMINI_MODELS[m] || m;
}

async function ensureRow() {
  await db.query(
    `INSERT INTO openai_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );
  await db.query(
    `ALTER TABLE openai_settings ADD COLUMN IF NOT EXISTS provider VARCHAR(40) DEFAULT 'openai'`
  );
  // Auto-upgrade deprecated Gemini model names stored in DB
  await db.query(
    `UPDATE openai_settings
     SET model = 'gemini-3.6-flash', updated_at = NOW()
     WHERE id = 1
       AND provider = 'gemini'
       AND model IN ('gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro')`
  );
}

async function getRow() {
  await ensureRow();
  const result = await db.query(`SELECT * FROM openai_settings WHERE id = 1`);
  return result.rows[0] || null;
}

function normalizeProvider(value) {
  const p = String(value || 'openai').toLowerCase().trim();
  return p === 'gemini' ? 'gemini' : 'openai';
}

async function getPublicStatus() {
  const row = await getRow();
  const provider = normalizeProvider(row?.provider || process.env.AI_PROVIDER || 'openai');
  const key = row?.api_key ? String(row.api_key).trim() : '';
  const envKey =
    provider === 'gemini'
      ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '')
      : (process.env.OPENAI_API_KEY || '');
  const envTrim = String(envKey).trim();
  const defaultModel = DEFAULT_MODELS[provider];
  let model = (row?.model && String(row.model).trim()) || process.env.AI_MODEL || defaultModel;
  if (provider === 'gemini') model = normalizeGeminiModel(model);
  return {
    provider,
    key_set: Boolean(key),
    key_preview: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    model,
    source: key ? 'database' : envTrim ? 'env' : 'none',
    updated_at: row?.updated_at || null,
  };
}

async function resolveConfig() {
  const row = await getRow();
  const provider = normalizeProvider(row?.provider || process.env.AI_PROVIDER || 'openai');
  let apiKey = row?.api_key ? String(row.api_key).trim() : '';
  if (!apiKey) {
    if (provider === 'gemini') {
      apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    } else {
      apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    }
  }
  const defaultModel = DEFAULT_MODELS[provider];
  let model =
    (row?.model && String(row.model).trim()) ||
    process.env.AI_MODEL ||
    (provider === 'openai' ? process.env.OPENAI_MODEL : null) ||
    defaultModel;
  if (provider === 'gemini') model = normalizeGeminiModel(model);
  return { provider, apiKey: apiKey || null, model };
}

async function updateSettings(body = {}) {
  await ensureRow();
  const current = await getRow();

  let apiKey = current?.api_key || null;
  if (body.api_key !== undefined && String(body.api_key).trim().length > 0) {
    apiKey = String(body.api_key).trim();
  }
  if (body.clear_key === true) {
    apiKey = null;
  }

  const provider =
    body.provider !== undefined
      ? normalizeProvider(body.provider)
      : normalizeProvider(current?.provider || 'openai');

  let model =
    body.model !== undefined
      ? String(body.model || '').trim()
      : current?.model || '';

  if (!model) model = DEFAULT_MODELS[provider];
  if (provider === 'gemini') model = normalizeGeminiModel(model);

  // If provider switched and model still looks like the other provider's default, reset
  if (body.provider !== undefined && body.model === undefined) {
    const prev = normalizeProvider(current?.provider);
    if (prev !== provider) model = DEFAULT_MODELS[provider];
  }

  await db.query(
    `UPDATE openai_settings
     SET api_key = $1, model = $2, provider = $3, updated_at = NOW()
     WHERE id = 1`,
    [apiKey, model, provider]
  );

  return getPublicStatus();
}

module.exports = {
  getPublicStatus,
  resolveConfig,
  updateSettings,
  DEFAULT_MODELS,
};
