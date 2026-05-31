using 'main.bicep'

// ── Resource Group + region + naming ────────────────────────────────────────
// Recommended regions (verified to host all 4 llmProfile model+SKU combos):
//   germanywestcentral | switzerlandnorth | swedencentral
// Any other Azure region works as long as your chosen llmProfile models are
// available there (check with: az cognitiveservices model list --location <region>).

param resourceGroupName = 'rg-icd-classifier'
param location          = 'germanywestcentral'
param nameSuffix        = 'icdv2'

// ── LLM profile ─────────────────────────────────────────────────────────────
// aoai-eu        — default; gpt-5.4 (DataZone) + gpt-4.1-mini (DataZone)
// aoai-eu-cost   — gpt-5.4 (DataZone) + gpt-5.4-mini (Global) — cheaper fast tier
// mistral-eu     — Mistral-Large-3 (DataZone) only; one EU model, one EU provider
// mistral-eu-cost— Mistral-Large-3 (DataZone) + mistral-small-2503 (Global)

param llmProfile           = 'aoai-eu'
param llmReasoningCapacity = 100
param llmFastCapacity      = 50
param reasoningEffort      = 'medium'

// ── WHO ICD-11 API credentials ──────────────────────────────────────────────
// Leave empty and let deploy.ps1 / az cli inject them from local.settings.json
// to avoid committing secrets. Only required when defaultSystem = 'icd11'.

param whoIcdClientId     = ''
param whoIcdClientSecret = ''
param whoIcdRelease      = '2026-01'
param whoIcdLanguage     = 'de'

param defaultSystem = 'icd10gm'

// ── APIM facade (optional) ──────────────────────────────────────────────────
// Off by default to avoid surprise costs.

param deployApim         = false
param apimPublisherEmail = ''
param apimPublisherName  = 'ICD Classifier'
