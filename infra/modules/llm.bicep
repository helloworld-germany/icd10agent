// LLM provider module — Azure AI Foundry / AI Services account with
// profile-driven model deployments. Hosts BOTH Azure OpenAI and Mistral
// models behind the same OpenAI-compatible /openai/v1 endpoint.
//
// Profiles:
//   aoai-eu        : gpt-5.4 (DataZone) + gpt-4.1-mini (DataZone)
//   aoai-eu-cost   : gpt-5.4 (DataZone) + gpt-5.4-mini (Global)
//   mistral-eu     : Mistral-Large-3 (DataZone) for both roles
//   mistral-eu-cost: Mistral-Large-3 (DataZone) + mistral-small-2503 (Global)

@description('Azure region for the AIServices account.')
param location string

@description('Unique suffix appended to resource names.')
@minLength(3)
@maxLength(8)
param nameSuffix string

@description('LLM profile to provision.')
@allowed([
  'aoai-eu'
  'aoai-eu-cost'
  'mistral-eu'
  'mistral-eu-cost'
])
param profile string

@description('TPM capacity (thousands of tokens per minute) for the reasoning deployment.')
@minValue(1)
param reasoningCapacity int = 100

@description('TPM capacity for the fast deployment.')
@minValue(1)
param fastCapacity int = 50

// ── Profile → model lookup ──────────────────────────────────────────────────
// Each profile entry is fully self-describing so the deployment resources
// below stay declarative. Versions are pinned to known-good releases.
// `maxFast` is a known per-account/per-region quota ceiling (May 2026) used
// to clamp `fastCapacity` so a default 1-click deploy doesn't fail pre-flight
// when the user hasn't requested extra quota yet.

// `maxReasoning` / `maxFast` are known per-account/per-region quota ceilings
// (May 2026, verified via `az deployment sub validate`) used to clamp the
// user-provided capacity values so a default 1-click deploy doesn't fail
// pre-flight when no extra quota was requested yet.
var profiles = {
  'aoai-eu': {
    providerTag: 'aoai'
    reasoning: { format: 'OpenAI',    name: 'gpt-5.4',            version: '2026-03-05', sku: 'DataZoneStandard' }
    fast:      { format: 'OpenAI',    name: 'gpt-4.1-mini',       version: '2025-04-14', sku: 'DataZoneStandard' }
    singleModel: false
    maxReasoning: 1000
    maxFast: 1000
  }
  'aoai-eu-cost': {
    providerTag: 'aoai'
    reasoning: { format: 'OpenAI',    name: 'gpt-5.4',            version: '2026-03-05', sku: 'DataZoneStandard' }
    fast:      { format: 'OpenAI',    name: 'gpt-5.4-mini',       version: '2026-03-17', sku: 'GlobalStandard' }
    singleModel: false
    maxReasoning: 1000
    maxFast: 1000
  }
  'mistral-eu': {
    providerTag: 'mistral'
    reasoning: { format: 'Mistral AI', name: 'Mistral-Large-3',   version: '1',          sku: 'DataZoneStandard' }
    fast:      { format: 'Mistral AI', name: 'Mistral-Large-3',   version: '1',          sku: 'DataZoneStandard' }
    singleModel: true
    maxReasoning: 20
    maxFast: 20
  }
  'mistral-eu-cost': {
    providerTag: 'mistral'
    reasoning: { format: 'Mistral AI', name: 'Mistral-Large-3',   version: '1',          sku: 'DataZoneStandard' }
    fast:      { format: 'Mistral AI', name: 'mistral-small-2503', version: '1',         sku: 'GlobalStandard' }
    singleModel: false
    maxReasoning: 20
    maxFast: 1
  }
}

var p = profiles[profile]
var effectiveReasoningCapacity = min(reasoningCapacity, p.maxReasoning)
var effectiveFastCapacity = min(fastCapacity, p.maxFast)

// ── AIServices account ─────────────────────────────────────────────────────
// kind 'AIServices' supports both OpenAI and Mistral deployments under one
// account and exposes them via the OpenAI-compatible /openai/v1 route.

resource ai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'ai-icd-${nameSuffix}'
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'ai-icd-${nameSuffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// Deployment specs as an array: 1 entry for single-model profiles
// (mistral-eu), 2 entries for dual-model profiles. We deploy them serially
// via @batchSize(1) because Azure rejects parallel deployments against the
// same Cognitive Services account.
var deploymentSpecs = p.singleModel ? [
  { name: p.reasoning.name, sku: p.reasoning.sku, capacity: effectiveReasoningCapacity, format: p.reasoning.format, version: p.reasoning.version }
] : [
  { name: p.reasoning.name, sku: p.reasoning.sku, capacity: effectiveReasoningCapacity, format: p.reasoning.format, version: p.reasoning.version }
  { name: p.fast.name,      sku: p.fast.sku,      capacity: effectiveFastCapacity,      format: p.fast.format,      version: p.fast.version }
]

@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for spec in deploymentSpecs: {
  parent: ai
  name: spec.name
  sku: {
    name: spec.sku
    capacity: spec.capacity
  }
  properties: {
    model: {
      format: spec.format
      name: spec.name
      version: spec.version
    }
  }
}]

// ── Outputs ─────────────────────────────────────────────────────────────────

output accountId string = ai.id
output accountName string = ai.name
output endpoint string = ai.properties.endpoint
output providerTag string = p.providerTag                       // 'aoai' | 'mistral'
output reasoningDeploymentName string = p.reasoning.name
output fastDeploymentName string = p.singleModel ? p.reasoning.name : p.fast.name
output reasoningModelLabel string = '${p.reasoning.format} ${p.reasoning.name}@${p.reasoning.version} (${p.reasoning.sku})'
output fastModelLabel string = '${p.fast.format} ${p.fast.name}@${p.fast.version} (${p.fast.sku})'
