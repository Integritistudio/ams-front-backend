const express = require('express');
const { authenticate, attachPermissions } = require('../middleware/auth');
const openaiSettings = require('../services/openaiSettings');

const router = express.Router();
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

function localImprove(text, type) {
  const val = String(text || '').trim();
  if (type === 'subject') {
    return val.length < 15
      ? `[IT Incident/Issue] ${val.charAt(0).toUpperCase()}${val.slice(1)} - Priority Check`
      : val;
  }
  if (type === 'description') {
    return `Issue Description & Symptom Breakdown:\n• Observed Behavior: ${val}\n• Impact: Affecting daily workflow / user productivity.\n• Request: Immediate diagnosis and resolution by IT Support.`;
  }
  if (type === 'justification') {
    return `Business Justification & Project Alignment:\n• Objective: ${val}\n• ROI / Productivity Impact: Essential hardware/software resource to meet project delivery timelines.`;
  }
  return val;
}

function systemPrompt(type) {
  const prompts = {
    subject: 'Rewrite this IT helpdesk ticket subject to be clear, professional, and concise (max 120 characters). Return only the improved subject text.',
    description: 'Rewrite this IT helpdesk ticket description into a clear structured report with observed behavior, impact, and requested action. Return plain text only.',
    justification: 'Rewrite this asset requisition justification into a professional business justification covering objective and productivity impact. Return plain text only.',
  };
  return prompts[type] || prompts.description;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`AI request timed out after ${timeoutMs}ms`);
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function improveWithOpenAI(apiKey, model, text, type) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: type === 'subject' ? 80 : 400,
      messages: [
        { role: 'system', content: systemPrompt(type) },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`OpenAI request failed: ${res.status} ${errText.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim() || null;
}

async function improveWithGemini(apiKey, model, text, type) {
  // Default / fallback Gemini model
  const modelId = model || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const started = Date.now();
  console.log(`[AI] Gemini request model=${modelId}`);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt(type)}\n\nDraft:\n${text}` }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: type === 'subject' ? 80 : 400,
      },
    }),
  });

  console.log(`[AI] Gemini HTTP ${res.status} in ${Date.now() - started}ms`);

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini request failed: ${res.status} ${errText.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const out = parts.map((p) => p.text || '').join('').trim();
  return out || null;
}

async function improveWithProvider(text, type) {
  const { provider, apiKey, model } = await openaiSettings.resolveConfig();
  if (!apiKey) return { text: null, provider: 'local' };

  if (provider === 'gemini') {
    const improved = await improveWithGemini(apiKey, model, text, type);
    return { text: improved, provider: improved ? 'gemini' : 'local' };
  }

  const improved = await improveWithOpenAI(apiKey, model, text, type);
  return { text: improved, provider: improved ? 'openai' : 'local' };
}

router.use(authenticate, attachPermissions);

router.post('/improve', async (req, res, next) => {
  const started = Date.now();
  try {
    const text = String(req.body?.text || '').trim();
    const type = String(req.body?.type || 'description');
    if (!text) {
      return res.status(400).json({ success: false, message: 'Please write a draft first.' });
    }
    if (!['subject', 'description', 'justification'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid improve type' });
    }

    let improved = null;
    let provider = 'local';
    try {
      const result = await improveWithProvider(text, type);
      improved = result.text;
      provider = result.provider || 'local';
    } catch (err) {
      console.warn(`[AI] improve failed after ${Date.now() - started}ms:`, err.message);
    }

    if (!improved) improved = localImprove(text, type);

    const cfg = await openaiSettings.resolveConfig();
    const label =
      provider === 'gemini'
        ? 'Improved with Gemini'
        : provider === 'openai'
          ? 'Improved with OpenAI'
          : cfg.apiKey
            ? 'AI provider call failed — used local formatter'
            : 'Improved with local formatter (set API key in Settings)';

    console.log(`[AI] /improve done provider=${provider} in ${Date.now() - started}ms`);
    return res.json({
      success: true,
      data: { text: improved, provider, ms: Date.now() - started },
      message: label,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
