// Core infrastructure for icd-classifier.
// Function App (Elastic Premium, VNet-integrated, MI/RBAC only) + Storage
// (private endpoints) + App Insights + Computer Vision + AI Foundry account
// (delegated to ./llm.bicep).

@description('Azure region for all resources. Recommended (Mistral + DataZoneStandard SKUs verified): germanywestcentral, switzerlandnorth, swedencentral.')
param location string

@description('Unique suffix for globally unique names.')
@minLength(3)
@maxLength(8)
param nameSuffix string

@description('Node.js runtime version (e.g. ~22).')
param nodeVersion string = '~22'

@secure()
param whoIcdClientId string = ''

@secure()
param whoIcdClientSecret string = ''

param whoIcdRelease string = '2026-01'
param whoIcdLanguage string = 'de'
param icd10gmValueSetUrl string = 'https://terminologien.bfarm.de/rendering_data/ValueSet-icd10gm-terminale-codes-2026.json'

@allowed(['icd10gm', 'icd11'])
param defaultSystem string = 'icd10gm'

// ── LLM profile (delegated to ./llm.bicep) ─────────────────────────────────

@description('LLM profile. aoai-eu = gpt-5.4 + gpt-4.1-mini (both DataZone). aoai-eu-cost = gpt-5.4 DataZone + gpt-5.4-mini Global. mistral-eu = Mistral-Large-3 only (DataZone). mistral-eu-cost = Mistral-Large-3 DataZone + mistral-small-2503 Global.')
@allowed([
  'aoai-eu'
  'aoai-eu-cost'
  'mistral-eu'
  'mistral-eu-cost'
])
param llmProfile string = 'aoai-eu'

@minValue(1)
param llmReasoningCapacity int = 100

@minValue(1)
param llmFastCapacity int = 50

@description('Reasoning effort for the reasoning role (AOAI reasoning models only; ignored for Mistral). low | medium | high. Empty = model default.')
@allowed(['', 'low', 'medium', 'high'])
param reasoningEffort string = 'medium'

// ── BYOK (optional) ─────────────────────────────────────────────────────────

@description('Optional Key Vault secret URI for WHO_ICD_CLIENT_ID (BYOK).')
param whoIcdClientIdSecretUri string = ''

@description('Optional Key Vault secret URI for WHO_ICD_CLIENT_SECRET (BYOK).')
param whoIcdClientSecretSecretUri string = ''

// ── Run-from-package (optional) ─────────────────────────────────────────────

@description('Public HTTPS URL of a function-app .zip package to mount via WEBSITE_RUN_FROM_PACKAGE. Empty = deploy code separately.')
param functionPackageUrl string = ''

// ── Built-in role definition IDs ────────────────────────────────────────────

var cognitiveServicesUserRole = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var cognitiveServicesOpenAIUserRole = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var storageBlobDataOwnerRole = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageQueueDataContributorRole = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributorRole = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

var storageSubResources = ['blob', 'queue', 'table', 'file']

// ── Storage (Functions runtime — MI, no shared keys) ───────────────────────

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'sticd${nameSuffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// ── VNet (Function App integration + private endpoints) ─────────────────────

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-icd-${nameSuffix}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.30.0.0/16'] }
  }
}

resource subnetApp 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-app'
  properties: {
    addressPrefix: '10.30.1.0/24'
    delegations: [
      {
        name: 'delegation-app'
        properties: { serviceName: 'Microsoft.Web/serverFarms' }
      }
    ]
  }
}

resource subnetPe 'Microsoft.Network/virtualNetworks/subnets@2024-01-01' = {
  parent: vnet
  name: 'snet-pe'
  properties: {
    addressPrefix: '10.30.2.0/24'
    privateEndpointNetworkPolicies: 'Disabled'
  }
  dependsOn: [subnetApp]
}

// ── App Service Plan (Elastic Premium — required for RBAC-only storage) ─────

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-icd-${nameSuffix}'
  location: location
  kind: 'elastic'
  sku: { name: 'EP1', tier: 'ElasticPremium' }
  properties: { reserved: true }
}

// ── App Insights ────────────────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'ai-icd-${nameSuffix}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Request_Source: 'rest'
  }
}

// ── Azure AI Vision ─────────────────────────────────────────────────────────

resource vision 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'cv-icd-${nameSuffix}'
  location: location
  kind: 'ComputerVision'
  sku: { name: 'S1' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'cv-icd-${nameSuffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// ── LLM (AIServices account + profile-driven model deployments) ────────────

module llm './llm.bicep' = {
  name: 'llm-${nameSuffix}'
  params: {
    location: location
    nameSuffix: nameSuffix
    profile: llmProfile
    reasoningCapacity: llmReasoningCapacity
    fastCapacity: llmFastCapacity
  }
}

// Direct handle to the AIServices account so RBAC can be scoped to it
// (a role assignment cannot be scoped to a module's output id).
resource llmAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: 'ai-icd-${nameSuffix}'
}

// ── Function App ────────────────────────────────────────────────────────────

var isMistral = llm.outputs.providerTag == 'mistral'

var baseAppSettings = [
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
  { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: nodeVersion }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
  { name: 'AzureWebJobsStorage__accountName', value: storage.name }
  { name: 'WEBSITE_CONTENTOVERVNET', value: '1' }
  { name: 'WEBSITE_VNET_ROUTE_ALL', value: '1' }
  { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
]

var packageAppSettings = empty(functionPackageUrl) ? [] : [
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: functionPackageUrl }
]

// Provider-specific env vars. Both Mistral and AOAI use the same AIServices
// account endpoint; runtime auto-detects from which AZURE_*_ENDPOINT is set.
var aoaiSettings = [
  { name: 'AZURE_OPENAI_AUTH_MODE', value: 'rbac' }
  { name: 'AZURE_OPENAI_ENDPOINT', value: llm.outputs.endpoint }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: llm.outputs.reasoningDeploymentName }
  { name: 'AZURE_OPENAI_DEPLOYMENT_REASONING', value: llm.outputs.reasoningDeploymentName }
  { name: 'AZURE_OPENAI_DEPLOYMENT_FAST', value: llm.outputs.fastDeploymentName }
  { name: 'AZURE_OPENAI_REASONING_EFFORT_REASONING', value: reasoningEffort }
]

var mistralSettings = [
  { name: 'AZURE_MISTRAL_AUTH_MODE', value: 'rbac' }
  { name: 'AZURE_MISTRAL_ENDPOINT', value: llm.outputs.endpoint }
  { name: 'AZURE_MISTRAL_DEPLOYMENT', value: llm.outputs.reasoningDeploymentName }
  { name: 'AZURE_MISTRAL_DEPLOYMENT_REASONING', value: llm.outputs.reasoningDeploymentName }
  { name: 'AZURE_MISTRAL_DEPLOYMENT_FAST', value: llm.outputs.fastDeploymentName }
]

// Provider is auto-detected at runtime from the presence of AZURE_*_ENDPOINT
// vars, so we just emit the right block here — no LLM_PROVIDER needed.
var llmSettings = isMistral ? mistralSettings : aoaiSettings

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-icd-${nameSuffix}'
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    virtualNetworkSubnetId: subnetApp.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: union(baseAppSettings, packageAppSettings, llmSettings, [
        { name: 'DEFAULT_SYSTEM', value: defaultSystem }
        { name: 'ICD10GM_VALUESET_URL', value: icd10gmValueSetUrl }
        { name: 'WHO_ICD_RELEASE', value: whoIcdRelease }
        { name: 'WHO_ICD_LANGUAGE', value: whoIcdLanguage }
        { name: 'WHO_ICD_CLIENT_ID', value: empty(whoIcdClientIdSecretUri) ? whoIcdClientId : '@Microsoft.KeyVault(SecretUri=${whoIcdClientIdSecretUri})' }
        { name: 'WHO_ICD_CLIENT_SECRET', value: empty(whoIcdClientSecretSecretUri) ? whoIcdClientSecret : '@Microsoft.KeyVault(SecretUri=${whoIcdClientSecretSecretUri})' }
        { name: 'AZURE_VISION_ENDPOINT', value: vision.properties.endpoint }
      ])
    }
  }
  dependsOn: [storagePeDnsGroups]
}

// ── RBAC ───────────────────────────────────────────────────────────────────

// Vision (read-only inference)
resource visionRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vision.id, functionApp.id, cognitiveServicesUserRole)
  scope: vision
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// AI Foundry (OpenAI + Mistral deployments) — same role works for both via /openai/v1
resource llmRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(llmAccount.id, functionApp.id, cognitiveServicesOpenAIUserRole)
  scope: llmAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAIUserRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage (Blob, Queue, Table)
resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, storageBlobDataOwnerRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storageQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, storageQueueDataContributorRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, storageTableDataContributorRole)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Private Endpoints + DNS (Storage over VNet) ─────────────────────────────

resource storageDnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for sub in storageSubResources: {
  name: 'privatelink.${sub}.${environment().suffixes.storage}'
  location: 'global'
}]

resource storageDnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (sub, i) in storageSubResources: {
  parent: storageDnsZones[i]
  name: 'link-${sub}'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}]

resource storagePe 'Microsoft.Network/privateEndpoints@2024-01-01' = [for sub in storageSubResources: {
  name: 'pe-${sub}-icd-${nameSuffix}'
  location: location
  properties: {
    subnet: { id: subnetPe.id }
    privateLinkServiceConnections: [
      {
        name: sub
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [sub]
        }
      }
    ]
  }
}]

resource storagePeDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = [for (sub, i) in storageSubResources: {
  parent: storagePe[i]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: sub
        properties: { privateDnsZoneId: storageDnsZones[i].id }
      }
    ]
  }
}]

// ── Outputs ─────────────────────────────────────────────────────────────────

output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output visionEndpoint string = vision.properties.endpoint
output llmEndpoint string = llm.outputs.endpoint
output llmProvider string = llm.outputs.providerTag
output llmReasoningDeployment string = llm.outputs.reasoningDeploymentName
output llmFastDeployment string = llm.outputs.fastDeploymentName
output llmReasoningModelLabel string = llm.outputs.reasoningModelLabel
output llmFastModelLabel string = llm.outputs.fastModelLabel
