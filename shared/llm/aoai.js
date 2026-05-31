'use strict';

// Azure OpenAI provider.
// Surface: getConfig(role) -> cfg ; callChat(cfg, messages, temperature) -> parsed JSON.
// cfg.provider is stamped 'aoai' so the dispatcher in ./index.js can route.

const { getEnv } = require('../http');
const { getCognitiveServicesToken } = require('../auth');

function normalizeBaseUrl(endpointOrBaseUrl) {
  const raw = (endpointOrBaseUrl || '').trim();
  if (!raw) return '';
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, '');
  const needsV1 = !path.toLowerCase().endsWith('/openai/v1');
  u.pathname = needsV1 ? `${path}/openai/v1/` : `${path}/`;
  return u.toString();
}

// Two roles are supported:
//   - "reasoning": heavyweight dual-classification step.
//     Picks AZURE_OPENAI_DEPLOYMENT_REASONING, else AZURE_OPENAI_DEPLOYMENT.
//   - "fast": term-extraction (Pass 1) and verifier pass.
//     Picks AZURE_OPENAI_DEPLOYMENT_FAST, else AZURE_OPENAI_DEPLOYMENT.
// Backward compatible: if only AZURE_OPENAI_DEPLOYMENT is configured, both
// roles resolve to the same deployment.
function getConfig(role = 'reasoning') {
  const endpoint = getEnv('AZURE_OPENAI_ENDPOINT');
  const baseUrl = normalizeBaseUrl(getEnv('AZURE_OPENAI_BASE_URL') || endpoint);
  const fallback = getEnv('AZURE_OPENAI_DEPLOYMENT');
  const roleEnv = role === 'fast'
    ? getEnv('AZURE_OPENAI_DEPLOYMENT_FAST')
    : getEnv('AZURE_OPENAI_DEPLOYMENT_REASONING');
  const deployment = roleEnv || fallback;
  const apiKey = getEnv('AZURE_OPENAI_API_KEY');
  const authMode = (getEnv('AZURE_OPENAI_AUTH_MODE', 'rbac')).toLowerCase();
  // Optional per-role reasoning_effort (low|medium|high). Empty/unset = omit
  // the parameter (model uses its default). Only valid for reasoning-capable
  // model families; non-reasoning models will reject it with HTTP 400.
  const effortEnv = role === 'fast'
    ? getEnv('AZURE_OPENAI_REASONING_EFFORT_FAST')
    : getEnv('AZURE_OPENAI_REASONING_EFFORT_REASONING');
  const reasoningEffort = (effortEnv || '').trim().toLowerCase() || null;
  return { provider: 'aoai', baseUrl, deployment, apiKey, authMode, role, reasoningEffort };
}

async function headers(cfg) {
  if (cfg.authMode === 'apikey' && cfg.apiKey) {
    return { 'api-key': cfg.apiKey, 'content-type': 'application/json' };
  }
  const token = await getCognitiveServicesToken();
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function callChat(cfg, messages, temperature = 0.0) {
  const url = `${cfg.baseUrl}chat/completions`;
  const body = {
    model: cfg.deployment,
    messages,
    response_format: { type: 'json_object' },
  };
  if (cfg.reasoningEffort) {
    // Reasoning models require the default temperature → omit it explicitly.
    body.reasoning_effort = cfg.reasoningEffort;
  } else {
    body.temperature = temperature;
  }
  const h = await headers(cfg);
  // 60s upper bound so an upstream stall can't burn the full 5-minute
  // Function timeout silently.
  const res = await fetch(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`AOAI HTTP ${res.status}: ${txt.substring(0, 500)}`);
  const data = JSON.parse(txt);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AOAI: empty content');
  return JSON.parse(content);
}

module.exports = { getConfig, callChat };
