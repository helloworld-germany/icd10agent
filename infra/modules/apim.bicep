// ---------------------------------------------------------------------------
// APIM facade for the icd-classifier Function App
// ---------------------------------------------------------------------------
// Creates an APIM (Consumption tier), a named-value placeholder for the
// function key (filled by deploy.ps1 post-deployment), one product
// "icd-classifier", and two APIs (icd11, icd10gm) backed by the same Function
// App. Each API pins the ?system= query parameter via policy, so the
// low-code caller does not need to know about it.
// ---------------------------------------------------------------------------

@description('Resource location')
param location string

@description('Unique suffix for globally unique names (3-8 chars, lowercase)')
param nameSuffix string

@description('Publisher email shown in the APIM developer portal')
param publisherEmail string

@description('Publisher organization name')
param publisherName string

@description('Function App default hostname (e.g. func-icd-xxx.azurewebsites.net)')
param functionAppHostName string

@description('Initial function key (optional). If empty, deploy.ps1 sets it post-deploy.')
@secure()
param functionKeyValue string = ''

// ── APIM service (Consumption tier) ─────────────────────────────────────────

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: 'apim-icd-${nameSuffix}'
  location: location
  sku: {
    name: 'Consumption'
    capacity: 0
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
  }
}

// ── Named value: function key (secret) ─────────────────────────────────────

resource nvFunctionKey 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'function-key'
  properties: {
    displayName: 'function-key'
    secret: true
    value: empty(functionKeyValue) ? 'placeholder-set-by-deploy-script' : functionKeyValue
  }
}

// ── Backend pointing at the Function App ───────────────────────────────────

resource backend 'Microsoft.ApiManagement/service/backends@2024-05-01' = {
  parent: apim
  name: 'function-app-backend'
  properties: {
    protocol: 'http'
    url: 'https://${functionAppHostName}/api'
    description: 'icd-classifier Function App'
  }
}

// ── Service-level policy: inject function key, set backend ─────────────────
// Notes for Consumption SKU:
//   - <base /> is NOT allowed at global scope (global IS the base).
//   - rate-limit-by-key / quota-by-key are NOT supported in Consumption.
//     If you need per-subscription throttling, upgrade to Basic+ or move
//     to an API-scope <rate-limit calls="..." renewal-period="..."/> policy
//     (which limits per API across all callers).

resource policyAll 'Microsoft.ApiManagement/service/policies@2024-05-01' = {
  parent: apim
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''
<policies>
  <inbound>
    <set-backend-service backend-id="function-app-backend" />
    <set-header name="x-functions-key" exists-action="override">
      <value>{{function-key}}</value>
    </set-header>
  </inbound>
  <backend>
    <forward-request />
  </backend>
  <outbound />
  <on-error />
</policies>
'''
  }
  dependsOn: [
    nvFunctionKey
    backend
  ]
}

// ── Product (one subscription bundles both APIs) ───────────────────────────

resource product 'Microsoft.ApiManagement/service/products@2024-05-01' = {
  parent: apim
  name: 'icd-classifier'
  properties: {
    displayName: 'ICD Classifier'
    description: 'ICD-10-GM und ICD-11 Klassifikation (Suche + Dokumentenanalyse)'
    state: 'published'
    subscriptionRequired: true
    approvalRequired: false
    subscriptionsLimit: 100
  }
}

// ── APIs ────────────────────────────────────────────────────────────────────

var openApiYaml = loadTextContent('../openapi/icd-api.yaml')

resource apiIcd11 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'icd11'
  properties: {
    displayName: 'ICD-11 Classifier'
    description: 'WHO ICD-11 MMS — Suche und Dokumentenklassifikation (deutsch).'
    path: 'icd11'
    protocols: ['https']
    subscriptionRequired: true
    format: 'openapi'
    value: openApiYaml
  }
}

resource policyIcd11 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: apiIcd11
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''
<policies>
  <inbound>
    <base />
    <set-query-parameter name="system" exists-action="override">
      <value>icd11</value>
    </set-query-parameter>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>
'''
  }
}

resource apiIcd10gm 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'icd10gm'
  properties: {
    displayName: 'ICD-10-GM Classifier'
    description: 'BfArM ICD-10-GM — Suche und Dokumentenklassifikation (deutsch).'
    path: 'icd10gm'
    protocols: ['https']
    subscriptionRequired: true
    format: 'openapi'
    value: openApiYaml
  }
}

resource policyIcd10gm 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: apiIcd10gm
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''
<policies>
  <inbound>
    <base />
    <set-query-parameter name="system" exists-action="override">
      <value>icd10gm</value>
    </set-query-parameter>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>
'''
  }
}

// ── Link APIs to product ───────────────────────────────────────────────────

resource productApiIcd11 'Microsoft.ApiManagement/service/products/apis@2024-05-01' = {
  parent: product
  name: 'icd11'
  dependsOn: [
    apiIcd11
  ]
}

resource productApiIcd10gm 'Microsoft.ApiManagement/service/products/apis@2024-05-01' = {
  parent: product
  name: 'icd10gm'
  dependsOn: [
    apiIcd10gm
  ]
}

// ── Default subscription for the product (one key for both APIs) ───────────
// You can create additional per-consumer subscriptions in the portal or via
// `az rest` / Bicep without modifying this module.

resource defaultSubscription 'Microsoft.ApiManagement/service/subscriptions@2024-05-01' = {
  parent: apim
  name: 'icd-classifier-default'
  properties: {
    displayName: 'ICD Classifier – Default'
    scope: product.id
    state: 'active'
    allowTracing: false
  }
  dependsOn: [
    productApiIcd11
    productApiIcd10gm
  ]
}

// ── Outputs ─────────────────────────────────────────────────────────────────

output apimName string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output icd11OpenApiUrl string = '${apim.properties.gatewayUrl}/icd11?export=true&format=openapi%2Bjson'
output icd10gmOpenApiUrl string = '${apim.properties.gatewayUrl}/icd10gm?export=true&format=openapi%2Bjson'
