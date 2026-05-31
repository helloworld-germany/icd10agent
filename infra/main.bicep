// ---------------------------------------------------------------------------
// icd-classifier — Full infrastructure (subscription-scoped)
// ---------------------------------------------------------------------------
// Usage:
//   az deployment sub create \
//     --location <region> \
//     --template-file infra/main.bicep \
//     --parameters infra/main.bicepparam
// ---------------------------------------------------------------------------

targetScope = 'subscription'

@description('Name of the resource group to create.')
param resourceGroupName string

@description('Azure region. Recommended (verified Mistral + DataZoneStandard SKUs): germanywestcentral, switzerlandnorth, swedencentral. Any other Azure region also works as long as your chosen llmProfile models are available there.')
param location string = 'germanywestcentral'

@description('Unique suffix for globally unique names (lowercase, 3-8 chars).')
@minLength(3)
@maxLength(8)
param nameSuffix string

@description('Node.js runtime version.')
param nodeVersion string = '~22'

@description('LLM profile. aoai-eu = gpt-5.4 (DataZone) + gpt-4.1-mini (DataZone) — recommended default. aoai-eu-cost = gpt-5.4 (DataZone) + gpt-5.4-mini (Global). mistral-eu = Mistral-Large-3 (DataZone) only, single model for both roles. mistral-eu-cost = Mistral-Large-3 (DataZone) + mistral-small-2503 (Global).')
@allowed([
  'aoai-eu'
  'aoai-eu-cost'
  'mistral-eu'
  'mistral-eu-cost'
])
param llmProfile string = 'aoai-eu'

@description('TPM capacity (thousands tokens/min) for the reasoning deployment.')
@minValue(1)
param llmReasoningCapacity int = 100

@description('TPM capacity for the fast deployment.')
@minValue(1)
param llmFastCapacity int = 50

@description('Reasoning effort for the reasoning role (AOAI reasoning models only; ignored for Mistral). Empty = model default.')
@allowed(['', 'low', 'medium', 'high'])
param reasoningEffort string = 'medium'

@description('WHO ICD-API client id (https://icd.who.int/icdapi). Required only for ICD-11.')
@secure()
param whoIcdClientId string = ''

@description('WHO ICD-API client secret. Required only for ICD-11.')
@secure()
param whoIcdClientSecret string = ''

@description('WHO ICD-11 release.')
param whoIcdRelease string = '2026-01'

@description('WHO ICD-11 language (ISO 639-1).')
param whoIcdLanguage string = 'de'

@description('BfArM ICD-10-GM ValueSet JSON URL.')
param icd10gmValueSetUrl string = 'https://terminologien.bfarm.de/rendering_data/ValueSet-icd10gm-terminale-codes-2026.json'

@description('Default classification system for requests without ?system=.')
@allowed(['icd10gm', 'icd11'])
param defaultSystem string = 'icd10gm'

@description('Deploy APIM facade in front of the Function App.')
param deployApim bool = false

@description('Publisher email for the APIM developer portal (required if deployApim=true).')
param apimPublisherEmail string = ''

@description('Publisher organization name shown in the APIM developer portal.')
param apimPublisherName string = 'ICD Classifier'

@description('Optional Key Vault secret URI for WHO_ICD_CLIENT_ID (BYOK).')
param whoIcdClientIdSecretUri string = ''

@description('Optional Key Vault secret URI for WHO_ICD_CLIENT_SECRET (BYOK).')
param whoIcdClientSecretSecretUri string = ''

@description('Optional public HTTPS URL of a Function App .zip package for true 1-click code deploy.')
param functionPackageUrl string = ''

// ── Resource Group ──────────────────────────────────────────────────────────

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

// ── Module: core infra ──────────────────────────────────────────────────────

module core 'modules/core.bicep' = {
  scope: rg
  name: 'core-${nameSuffix}'
  params: {
    location: location
    nameSuffix: nameSuffix
    nodeVersion: nodeVersion
    whoIcdClientId: whoIcdClientId
    whoIcdClientSecret: whoIcdClientSecret
    whoIcdRelease: whoIcdRelease
    whoIcdLanguage: whoIcdLanguage
    icd10gmValueSetUrl: icd10gmValueSetUrl
    defaultSystem: defaultSystem
    llmProfile: llmProfile
    llmReasoningCapacity: llmReasoningCapacity
    llmFastCapacity: llmFastCapacity
    reasoningEffort: reasoningEffort
    whoIcdClientIdSecretUri: whoIcdClientIdSecretUri
    whoIcdClientSecretSecretUri: whoIcdClientSecretSecretUri
    functionPackageUrl: functionPackageUrl
  }
}

// ── Module: APIM facade (optional) ──────────────────────────────────────────

module apim 'modules/apim.bicep' = if (deployApim) {
  scope: rg
  name: 'apim-${nameSuffix}'
  params: {
    location: location
    nameSuffix: nameSuffix
    publisherEmail: apimPublisherEmail
    publisherName: apimPublisherName
    functionAppHostName: '${core.outputs.functionAppName}.azurewebsites.net'
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────

output resourceGroupName string = rg.name
output functionAppName string = core.outputs.functionAppName
output functionAppUrl string = core.outputs.functionAppUrl
output visionEndpoint string = core.outputs.visionEndpoint
output llmEndpoint string = core.outputs.llmEndpoint
output llmProvider string = core.outputs.llmProvider
output llmReasoningDeployment string = core.outputs.llmReasoningDeployment
output llmFastDeployment string = core.outputs.llmFastDeployment
output llmReasoningModelLabel string = core.outputs.llmReasoningModelLabel
output llmFastModelLabel string = core.outputs.llmFastModelLabel
output apimName string = deployApim ? apim!.outputs.apimName : ''
output apimGatewayUrl string = deployApim ? apim!.outputs.gatewayUrl : ''
