'use strict';

// LLM provider dispatcher.
//
// Provider selection is auto-detected from the configured endpoint env vars:
//   - AZURE_MISTRAL_ENDPOINT set  -> Mistral (via Azure AI Foundry)
//   - AZURE_OPENAI_ENDPOINT set   -> Azure OpenAI
//   - both set                    -> error (ambiguous; remove one)
//   - neither set                 -> error (nothing to call)
//
// Both providers expose the same surface:
//   getConfig(role)                       -> cfg (with cfg.provider stamped)
//   callChat(cfg, messages, temperature)  -> parsed JSON object
// so callers in classifyGpt.js stay provider-agnostic.

const { getEnv } = require('../http');
const aoai = require('./aoai');
const mistral = require('./mistral');

function selected() {
  const hasMistral = !!(getEnv('AZURE_MISTRAL_ENDPOINT') || getEnv('AZURE_MISTRAL_BASE_URL'));
  const hasAoai = !!(getEnv('AZURE_OPENAI_ENDPOINT') || getEnv('AZURE_OPENAI_BASE_URL'));
  if (hasMistral && hasAoai) {
    throw new Error('LLM provider ambiguous: both AZURE_MISTRAL_ENDPOINT and AZURE_OPENAI_ENDPOINT are set. Remove one to disambiguate.');
  }
  if (hasMistral) return mistral;
  if (hasAoai) return aoai;
  throw new Error('No LLM provider configured: set either AZURE_OPENAI_ENDPOINT (Azure OpenAI) or AZURE_MISTRAL_ENDPOINT (Mistral via AI Foundry).');
}

function getConfig(role = 'reasoning') {
  return selected().getConfig(role);
}

function callChat(cfg, messages, temperature = 0.0) {
  // Route by the provider tag stamped onto cfg, so callers stay agnostic.
  const impl = cfg && cfg.provider === 'mistral' ? mistral : aoai;
  return impl.callChat(cfg, messages, temperature);
}

module.exports = { getConfig, callChat };
