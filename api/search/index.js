const DATA_URL = 'https://terminologien.bfarm.de/rendering_data/ValueSet-icd10gm-terminale-codes-2026.json';
const CACHE_MS = 24 * 60 * 60 * 1000;

const OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

let cachedIndex = null;
let cachedAt = 0;

function normalizeText(value) {
  return (value || '')
    .toString()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(norm) {
  const stop = new Set([
    'und', 'oder', 'mit', 'ohne', 'der', 'die', 'das', 'des', 'dem', 'den',
    'im', 'in', 'am', 'an', 'auf', 'bei', 'für', 'fur', 'von', 'zu', 'zum', 'zur',
    'eine', 'einer', 'eines', 'ein', 'nicht', 'naeher', 'naher', 'bezeichnet',
  ]);

  return norm
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 3)
    .filter(t => !stop.has(t));
}

function buildIndexRows(rows) {
  return rows
    .filter(r => r && typeof r.Code === 'string' && typeof r.Display === 'string')
    .map(r => {
      const code = r.Code;
      const display = r.Display;
      return {
        code,
        display,
        normCode: normalizeText(code),
        normDisplay: normalizeText(display),
      };
    });
}

function scoreRow(row, qNorm, qTokens) {
  let score = 0;

  // If the user typed something that looks like an ICD code, prioritize code matching.
  if (/^[a-z][0-9]{2}(\.[0-9a-z])?/.test(qNorm)) {
    if (row.normCode === qNorm) score += 100;
    else if (row.normCode.startsWith(qNorm)) score += 60;
  }

  if (qNorm && row.normDisplay.includes(qNorm)) score += 12;
  for (const t of qTokens) {
    if (row.normDisplay.includes(t)) score += 4;
  }

  // Prefer more specific codes in ties.
  score += Math.min(row.code.length, 8) * 0.01;

  return score;
}

function stripLikelyIcdCodes(text) {
  // Defensive: never allow model output to directly provide ICD codes.
  // Remove patterns like A00, A00.0, B99, etc.
  return (text || '')
    .replace(/\b[A-Z][0-9]{2}(\.[0-9A-Z])?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getEnv(name) {
  const v = process.env[name];
  return (v && v.trim()) ? v.trim() : '';
}

function normalizeOpenAIBaseUrl(endpointOrBaseUrl) {
  const raw = (endpointOrBaseUrl || '').trim();
  if (!raw) return '';
  // Accept either:
  // - https://<resource>.openai.azure.com/
  // - https://<resource>.openai.azure.com/openai/v1/
  // and normalize to baseUrl ending with /openai/v1/
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, '');
  const needsV1 = !path.toLowerCase().endsWith('/openai/v1');
  u.pathname = needsV1 ? `${path}/openai/v1/` : `${path}/`;
  return u.toString();
}

let cachedCredential = null;
async function getBearerToken() {
  // Lazy-load so that non-LLM usage stays dependency-light.
  // eslint-disable-next-line global-require
  const { DefaultAzureCredential } = require('@azure/identity');
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  const token = await cachedCredential.getToken(OPENAI_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Entra ID token for Azure OpenAI');
  return token.token;
}

async function llmPrepareQuery(inputText) {
  const endpoint = getEnv('AZURE_OPENAI_ENDPOINT');
  const baseUrl = normalizeOpenAIBaseUrl(getEnv('AZURE_OPENAI_BASE_URL') || endpoint);
  const apiKey = getEnv('AZURE_OPENAI_API_KEY');
  const deployment = getEnv('AZURE_OPENAI_DEPLOYMENT');
  const authMode = (getEnv('AZURE_OPENAI_AUTH_MODE') || '').toLowerCase(); // 'rbac' | 'key'

  if (!baseUrl || !deployment) {
    return { preparedQuery: stripLikelyIcdCodes(inputText), usedLLM: false };
  }

  // Default to RBAC/Entra ID. Only use api-key if explicitly requested.
  const useRbac = authMode !== 'key';
  if (!useRbac && !apiKey) {
    return { preparedQuery: stripLikelyIcdCodes(inputText), usedLLM: false };
  }

  const url = new URL('chat/completions', baseUrl);

  const system = [
    'Du bist ein Hilfsmodul für eine ICD-10-GM Suche.',
    'Deine Aufgabe: aus Freitext eine kurze, gut suchbare deutsche Suchanfrage erzeugen.',
    'WICHTIG:',
    '- Gib KEINE ICD-10 Codes zurück (z.B. A00, A00.0, etc.).',
    '- Erfinde keine medizinischen Fakten.',
    '- Antworte ausschließlich als JSON Objekt: {"query":"..."}.',
    '- query: 3 bis 12 Wörter, nur Suchbegriffe, ohne Satzzeichen außer Leerzeichen und Bindestrich.',
  ].join('\n');

  const body = {
    model: deployment,
    messages: [
      // Reasoning models treat developer like system; don't mix system+developer.
      { role: 'developer', content: system },
      { role: 'user', content: inputText || '' },
    ],
    // Reasoning models: use max_completion_tokens (max_tokens/temperature may be unsupported).
    max_completion_tokens: 200,
  };

  const headers = {
    'content-type': 'application/json',
  };
  if (useRbac) {
    headers.authorization = `Bearer ${await getBearerToken()}`;
  } else {
    headers['api-key'] = apiKey;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}${txt ? `: ${txt.substring(0, 300)}` : ''}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI response missing message content');
  }

  let prepared = '';
  try {
    const parsed = JSON.parse(content);
    prepared = (parsed?.query || '').toString();
  } catch {
    // Fallback: if the model didn't comply, use raw content.
    prepared = content.toString();
  }

  prepared = stripLikelyIcdCodes(prepared);
  prepared = prepared
    .replace(/[^a-zA-Z0-9\s\-äöüÄÖÜß]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!prepared) {
    prepared = stripLikelyIcdCodes(inputText);
  }

  // Hard cap
  if (prepared.length > 120) prepared = prepared.slice(0, 120);

  return { preparedQuery: prepared, usedLLM: true };
}

async function getIndex() {
  const now = Date.now();
  if (cachedIndex && (now - cachedAt) < CACHE_MS) return cachedIndex;

  const res = await fetch(DATA_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.rows)) {
    throw new Error('Unexpected upstream JSON format (expected { rows: [...] })');
  }

  cachedIndex = buildIndexRows(data.rows);
  cachedAt = now;
  return cachedIndex;
}

module.exports = async function (context, req) {
  try {
    const text = (req.query.text || '').toString().trim();
    const q = (req.query.q || '').toString().trim();
    const limitRaw = (req.query.limit || '20').toString();
    const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 20));

    const input = q || text;
    if (!input) {
      context.res = {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
        body: { input: '', query: '', usedLLM: false, count: 0, results: [] },
      };
      return;
    }

    const index = await getIndex();

    // If user provided explicit q, use it as-is; otherwise LLM-prepare from text.
    let preparedQuery = q;
    let usedLLM = false;
    let llmError = '';
    if (!preparedQuery) {
      try {
        const prep = await llmPrepareQuery(text);
        preparedQuery = prep.preparedQuery;
        usedLLM = prep.usedLLM;
      } catch (e) {
        // Keep the product usable even if Azure OpenAI is temporarily unavailable
        // or RBAC/appsettings aren't fully in place yet.
        preparedQuery = stripLikelyIcdCodes(text);
        usedLLM = false;
        llmError = (e?.message || String(e) || '').toString();
        if (llmError.length > 2000) llmError = llmError.slice(0, 2000);
      }
    }

    const qNorm = normalizeText(preparedQuery);
    const qTokens = tokenize(qNorm);

    const results = index
      .map(r => ({ r, s: scoreRow(r, qNorm, qTokens) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(x => ({ code: x.r.code, display: x.r.display }));

    context.res = {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // keep responses uncacheable; upstream is cached in-memory anyway
        'cache-control': 'no-store',
      },
      body: {
        input,
        query: preparedQuery,
        usedLLM,
        ...(llmError ? { llmError } : {}),
        count: results.length,
        results,
      },
    };
  } catch (e) {
    context.res = {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: {
        error: 'search_failed',
        message: e?.message || String(e),
      },
    };
  }
};
