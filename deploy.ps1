<#
.SYNOPSIS
  Deploy icd-classifier infrastructure and function code to Azure.

.DESCRIPTION
  1. Reads WHO ICD-API credentials from local.settings.json (kept out of git).
  2. Deploys Bicep template (subscription-scoped) → creates resource group + all resources.
  3. Publishes function code via Azure Functions Core Tools.

.PARAMETER NameSuffix
  Short unique suffix for resource names (3-8 chars, lowercase). Default: icd01.

.PARAMETER Location
  Azure region. Default: swedencentral. Verified for all 4 LLM profiles:
  germanywestcentral | switzerlandnorth | swedencentral.

.PARAMETER ResourceGroupName
  Resource group name. Default: rg-icd-classifier.

.PARAMETER LlmProfile
  LLM profile (mirrors infra/main.bicep @allowed). Default: aoai-eu.
    aoai-eu        gpt-5.4 (DataZone) + gpt-4.1-mini (DataZone)        — recommended, 100% EU-DataZone
    aoai-eu-cost   gpt-5.4 (DataZone) + gpt-5.4-mini  (Global)         — cheaper fast tier
    mistral-eu     Mistral-Large-3 (DataZone) only                     — single EU model + EU provider
    mistral-eu-cost Mistral-Large-3 (DataZone) + mistral-small-2503 (Global)

.PARAMETER LlmReasoningCapacity
  TPM (thousands of tokens / min) for the reasoning deployment. Default 100.

.PARAMETER LlmFastCapacity
  TPM for the fast deployment. Default 50.

.PARAMETER ReasoningEffort
  Reasoning effort for AOAI reasoning models (low|medium|high, '' = model default).
  Ignored for Mistral profiles. Default: medium.

.PARAMETER SkipInfra
  Skip Bicep deployment, only publish function code.

.PARAMETER SkipCode
  Skip code publish, only deploy infrastructure.

.EXAMPLE
  .\deploy.ps1
  .\deploy.ps1 -NameSuffix icd02 -Location germanywestcentral
  .\deploy.ps1 -LlmProfile mistral-eu
  .\deploy.ps1 -LlmProfile aoai-eu-cost -LlmReasoningCapacity 200
  .\deploy.ps1 -SkipInfra      # only re-publish code
  .\deploy.ps1 -SkipCode       # only re-deploy infra
#>

param(
  [ValidateLength(3, 8)]
  [ValidatePattern('^[a-z0-9]{3,8}$')]
  [string]$NameSuffix = 'icd01',

  [string]$Location = 'swedencentral',
  [string]$ResourceGroupName = 'rg-icd-classifier',

  [ValidateSet('aoai-eu', 'aoai-eu-cost', 'mistral-eu', 'mistral-eu-cost')]
  [string]$LlmProfile = 'aoai-eu',

  [ValidateRange(1, 10000)]
  [int]$LlmReasoningCapacity = 100,

  [ValidateRange(1, 10000)]
  [int]$LlmFastCapacity = 50,

  [ValidateSet('', 'low', 'medium', 'high')]
  [string]$ReasoningEffort = 'medium',

  [switch]$SkipInfra,
  [switch]$SkipCode,

  # APIM facade for low-code consumers (Power Apps / Copilot Studio).
  [switch]$DeployApim,
  [string]$ApimPublisherEmail = '',
  [string]$ApimPublisherName = 'ICD Classifier'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$funcAppName = "func-icd-$NameSuffix"

# ── 1. Read WHO credentials from local.settings.json ────────────────────────

$whoClientId = ''
$whoClientSecret = ''
$localSettings = Join-Path $PSScriptRoot 'local.settings.json'
if (Test-Path $localSettings) {
  $ls = Get-Content $localSettings -Raw | ConvertFrom-Json
  if ($ls.Values.PSObject.Properties.Match('WHO_ICD_CLIENT_ID').Count)     { $whoClientId     = [string]$ls.Values.WHO_ICD_CLIENT_ID }
  if ($ls.Values.PSObject.Properties.Match('WHO_ICD_CLIENT_SECRET').Count) { $whoClientSecret = [string]$ls.Values.WHO_ICD_CLIENT_SECRET }
}
if (-not $whoClientId -or -not $whoClientSecret) {
  Write-Warning "WHO_ICD_CLIENT_ID / WHO_ICD_CLIENT_SECRET nicht in local.settings.json gefunden — ICD-11-Suche wird in Azure nicht funktionieren, bis du sie nachträglich setzt."
}

# ── 2. Infrastructure ───────────────────────────────────────────────────────

if (-not $SkipInfra) {
  Write-Host "`n=== Deploying infrastructure (RG '$ResourceGroupName', region '$Location', suffix '$NameSuffix') ===" -ForegroundColor Cyan

  if ($DeployApim -and -not $ApimPublisherEmail) {
    Write-Error "-DeployApim erfordert -ApimPublisherEmail '<deine@adresse>'."
    exit 1
  }

  Write-Host "  LLM profile      : $LlmProfile" -ForegroundColor DarkGray
  Write-Host "  Reasoning effort : $ReasoningEffort  (ignored for mistral-*)" -ForegroundColor DarkGray
  Write-Host "  Capacities       : reasoning=${LlmReasoningCapacity}k TPM, fast=${LlmFastCapacity}k TPM" -ForegroundColor DarkGray

  az deployment sub create `
    --location $Location `
    --template-file "$PSScriptRoot\infra\main.bicep" `
    --parameters "$PSScriptRoot\infra\main.bicepparam" `
    --parameters resourceGroupName=$ResourceGroupName `
                 location=$Location `
                 nameSuffix=$NameSuffix `
                 llmProfile=$LlmProfile `
                 llmReasoningCapacity=$LlmReasoningCapacity `
                 llmFastCapacity=$LlmFastCapacity `
                 reasoningEffort=$ReasoningEffort `
                 whoIcdClientId=$whoClientId `
                 whoIcdClientSecret=$whoClientSecret `
                 deployApim=$($DeployApim.IsPresent.ToString().ToLower()) `
                 apimPublisherEmail=$ApimPublisherEmail `
                 apimPublisherName=$ApimPublisherName `
    --name "icd-classifier-$(Get-Date -Format 'yyyyMMdd-HHmmss')" `
    --output table

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Bicep deployment failed."
    exit 1
  }

  Write-Host "Infrastructure deployed." -ForegroundColor Green
}

# ── 3. Publish function code ────────────────────────────────────────────────

if (-not $SkipCode) {
  Write-Host "`n=== Publishing function app '$funcAppName' (Kudu zip-deploy) ===" -ForegroundColor Cyan

  $zip = Join-Path $PSScriptRoot 'deploy.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }

  $include = @(
    'host.json', 'package.json', 'package-lock.json',
    'shared', 'classify', 'search', 'debug', 'config', 'node_modules'
  ) | Where-Object { Test-Path (Join-Path $PSScriptRoot $_) }

  Write-Host "Packaging ($($include -join ', ')) ..." -ForegroundColor DarkGray
  Push-Location $PSScriptRoot
  try {
    Compress-Archive -Path $include -DestinationPath $zip -Force
  } finally {
    Pop-Location
  }

  Write-Host "Uploading $zip ..." -ForegroundColor DarkGray
  az functionapp deployment source config-zip `
    --resource-group $ResourceGroupName `
    --name $funcAppName `
    --src $zip `
    --build-remote false `
    --timeout 600 | Out-Null

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Function publish failed."
    exit 1
  }
}

# ── 4. Print test commands ──────────────────────────────────────────────────

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "Function App:  https://$funcAppName.azurewebsites.net"
Write-Host "Debug page:    https://$funcAppName.azurewebsites.net/api/debug"
Write-Host ""
Write-Host "Get a function key:" -ForegroundColor Cyan
Write-Host "  az functionapp keys list -g $ResourceGroupName -n $funcAppName --query functionKeys.default -o tsv"
Write-Host ""
Write-Host "Smoke-test (replace <KEY>):" -ForegroundColor Cyan
Write-Host "  curl 'https://$funcAppName.azurewebsites.net/api/search?text=cholera&system=icd10gm&code=<KEY>'"
Write-Host "  curl 'https://$funcAppName.azurewebsites.net/api/search?text=diabetes%20typ%202&system=icd11&code=<KEY>'"

# ── 5. Seed APIM named-value with the current function key ─────────────────

$apimName = "apim-icd-$NameSuffix"
$apimExists = $(az apim show -g $ResourceGroupName -n $apimName --query name -o tsv 2>$null)
if ($apimExists) {
  Write-Host "`n=== Updating APIM 'function-key' named value ===" -ForegroundColor Cyan
  $fkey = az functionapp keys list -g $ResourceGroupName -n $funcAppName --query functionKeys.default -o tsv
  if (-not $fkey) {
    Write-Warning "Function key konnte nicht gelesen werden — APIM named value bleibt auf Placeholder."
  } else {
    az apim nv update -g $ResourceGroupName --service-name $apimName --named-value-id 'function-key' --value $fkey --secret true | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "APIM named value 'function-key' aktualisiert." -ForegroundColor Green
    } else {
      Write-Warning "az apim nv update fehlgeschlagen — bitte manuell setzen."
    }
  }

  $gw = az apim show -g $ResourceGroupName -n $apimName --query gatewayUrl -o tsv
  Write-Host ""
  Write-Host "APIM Gateway:        $gw" -ForegroundColor Cyan
  Write-Host "OpenAPI ICD-11:      $gw/icd11?export=true&format=openapi%2Bjson"
  Write-Host "OpenAPI ICD-10-GM:   $gw/icd10gm?export=true&format=openapi%2Bjson"

  # Fetch the default product subscription key and print it (mask but show).
  $azSub = az account show --query id -o tsv
  $subUrl = "https://management.azure.com/subscriptions/$azSub/resourceGroups/$ResourceGroupName/providers/Microsoft.ApiManagement/service/$apimName/subscriptions/icd-classifier-default/listSecrets?api-version=2024-05-01"
  $primary = az rest --method post --url $subUrl --query primaryKey -o tsv 2>$null
  if ($primary) {
    Write-Host ""
    Write-Host "Subscription Key (icd-classifier-default):" -ForegroundColor Green
    Write-Host "  $primary"
    Write-Host ""
    Write-Host "Smoke-Test:" -ForegroundColor Cyan
    Write-Host "  `$h = @{ 'Ocp-Apim-Subscription-Key' = '$primary' }"
    Write-Host "  Invoke-RestMethod '$gw/icd11/search?text=diabetes&limit=3' -Headers `$h"
  } else {
    Write-Warning "Subscription key konnte nicht gelesen werden — bitte im Portal unter APIM > Subscriptions abrufen."
  }
}
