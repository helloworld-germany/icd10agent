'use strict';

// Mistral provider via Azure AI Foundry / AI Services unified inference endpoint.
//
// Models like Mistral-Large-3, mistral-medium-2505, mistral-small-2503 are
// deployed to a Cognitive Services account of kind 'AIServices' (not 'OpenAI')
// and exposed through the OpenAI-compatible `/openai/v1/chat/completions`
// route — same shape as Azure OpenAI, with the deployment name in the body's
// `model` field. Auth uses the same Cognitive Services Entra ID scope.
//
// Reasoning_effort does NOT apply to Mistral models (no public reasoning
// tier on Azure as of this writing), so cfg.reasoningEffort is always null.

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

// Two roles, same semantics as the AOAI provider:
//   - "reasoning": picks AZURE_MISTRAL_DEPLOYMENT_REASONING, else AZURE_MISTRAL_DEPLOYMENT.
//   - "fast":      picks AZURE_MISTRAL_DEPLOYMENT_FAST,      else AZURE_MISTRAL_DEPLOYMENT.
function getConfig(role = 'reasoning') {
  const endpoint = getEnv('AZURE_MISTRAL_ENDPOINT');
  const baseUrl = normalizeBaseUrl(getEnv('AZURE_MISTRAL_BASE_URL') || endpoint);
  const fallback = getEnv('AZURE_MISTRAL_DEPLOYMENT');
  const roleEnv = role === 'fast'
    ? getEnv('AZURE_MISTRAL_DEPLOYMENT_FAST')
    : getEnv('AZURE_MISTRAL_DEPLOYMENT_REASONING');
  const deployment = roleEnv || fallback;
  const apiKey = getEnv('AZURE_MISTRAL_API_KEY');
  const authMode = (getEnv('AZURE_MISTRAL_AUTH_MODE', 'rbac')).toLowerCase();
  return { provider: 'mistral', baseUrl, deployment, apiKey, authMode, role, reasoningEffort: null };
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
    temperature,
    response_format: { type: 'json_object' },
  };
  const h = await headers(cfg);
  // 60s upper bound so an over-quota Foundry queue (which does NOT return 429)
  // can't burn the full 5-minute Function timeout silently.
  const res = await fetch(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Mistral HTTP ${res.status}: ${txt.substring(0, 500)}`);
  const data = JSON.parse(txt);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Mistral: empty content');
  return JSON.parse(content);
}

module.exports = { getConfig, callChat };
