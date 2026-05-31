# ICD-10-GM / ICD-11 Classifier

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fhelloworld-germany%2Ficd10agent%2Fmain%2Finfra%2Fmain.json/uiFormDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fhelloworld-germany%2Ficd10agent%2Fmain%2Finfra%2FuiFormDefinition.json)

> Infrastruktur als Code: [`infra/main.bicep`](infra/main.bicep) — lokal visualisierbar via VS Code Befehl `Bicep: Open Visualizer`.

> **1-Click Deployment**: Klick auf den blauen Button öffnet das Azure-Portal mit einem geführten Wizard. Alle Ressourcen werden in **Ihrem Tenant** angelegt, Authentifizierung läuft ausschließlich über **Managed Identity + RBAC**, Storage hängt an einem dedizierten **VNet mit Private Endpoints**. Keine Connection-Strings, keine Shared Keys.

Azure **Function App** zur Klassifikation klinischer Freitexte (sowie PDFs/Bildern via Azure AI Vision Read) gegen wahlweise:

- **ICD-10-GM** (BfArM ZTS ValueSet, Default), oder
- **ICD-11 MMS** (WHO ICD-API, deutsche "Testversion" / `Accept-Language: de`)

Umschaltung pro Request via `?system=icd10gm|icd11`. Default ist `icd10gm` (Setting `DEFAULT_SYSTEM`).

Die GPT-Klassifikation läuft als **Dual-Call** (context-aware + independent) gegen ein **wählbares LLM-Profil** (Azure OpenAI oder Mistral via Azure AI Foundry, siehe [LLM-Profile](#llm-profile)). Finale Codes kommen **immer** aus dem ICD-Provider, nie aus dem Modell.

---

## 1-Click-Deployment — Voraussetzungen & Ablauf

### Vor dem Klick

| Was | Wie prüfen / einrichten |
|---|---|
| **Azure-Subscription** mit Rechten auf Subscription-Ebene (`Owner` oder `Contributor + User Access Administrator`) | Portal → *Subscriptions → Access control (IAM)*. Ohne diese Rolle scheitert das Subscription-scoped Deployment, weil RBAC-Rollen angelegt werden. |
| **LLM-Quota** für das gewählte Profil in der gewählten Region | Default-Profil `aoai-eu` braucht **DataZoneStandard**-Quota für `gpt-5.4` und `gpt-4.1-mini`. `mistral-eu` braucht **DataZoneStandard**-Quota für `Mistral-Large-3`. `mistral-eu-cost` braucht **zusätzlich** eine erhöhte **Model-as-a-Service (MaaS)**-Pool-Quota für `mistral-small-2503` — der Subscription-Default ist 1 Pool-Slot (≈ 1 TPM) und reicht damit nur für sehr kurze Eingaben, nicht für volle Arztbriefe. Quota-Beantragung: [aka.ms/oai/quotaincrease](https://aka.ms/oai/quotaincrease). |
| **WHO ICD-API Account** *(nur für ICD-11)* | Kostenlos: <https://icd.who.int/icdapi> → *Register* → *API Access → Add new Client*. ClientId + Secret im Wizard eintragen — oder leer lassen wenn nur ICD-10-GM benötigt wird. |
| **Key Vault** *(optional, für BYOK)* | Siehe Abschnitt [BYOK](#byok--bring-your-own-key). |

### Klick & Wizard

1. Auf **Deploy to Azure** klicken.
2. Subscription + (neue oder bestehende) Resource Group + Region wählen (DataZone-verifiziert: `germanywestcentral`, `switzerlandnorth`, `swedencentral`).
3. `nameSuffix` setzen (3-8 lowercase, eindeutig — z. B. `klinik1`).
4. **LLM-Profil-Tab**: Profil aus 4 Optionen wählen (siehe [LLM-Profile](#llm-profile)). Capacity-Slider an Quota anpassen. Reasoning-Effort (`low`/`medium`/`high`) nur relevant für AOAI-Reasoning-Modelle.
5. **ICD-11-Tab** *(optional)*: WHO-Credentials eintragen, sonst leer.
6. **BYOK-Tab** *(optional)*: Key-Vault-Secret-URIs eintragen, sonst leer.
7. **Code & APIM-Tab**: Package-URL stehen lassen (= GitHub-Release-ZIP) oder leeren, um den Code später per `deploy.ps1 -SkipInfra` zu publishen.
8. *Review + create*. Deployment-Dauer: ~10-15 Min (APIM braucht zusätzliche ~25 Min).

### Nach dem Deployment

```powershell
# Function Key abrufen
az functionapp keys list -g <RG> -n func-icd-<suffix> --query functionKeys.default -o tsv

# Smoke-Test
curl "https://func-icd-<suffix>.azurewebsites.net/api/search?text=cholera&system=icd10gm&code=<KEY>"

# UI öffnen
start https://func-icd-<suffix>.azurewebsites.net/api/debug
```

> **Wenn das Function-Package-Feld leer war**, jetzt einmalig Code publishen:
> ```powershell
> .\deploy.ps1 -SkipInfra -ResourceGroup <RG> -NameSuffix <suffix>
> ```

---

## Compliance & Region

| Mandant | Empfohlene Azure-Region | Geprüft am | Datenresidenz (DataZone EU) |
|---|---|---|---|
| **DE / AT** | `germanywestcentral` (Frankfurt) | 2026-05-31 via `az deployment sub validate` | EU |
| **CH**      | `switzerlandnorth` (Zürich)      | 2026-05-31 via `az deployment sub validate` | EU |
| **EU**      | `swedencentral` (Gävle)          | 2026-05-31 via `az deployment sub validate` | EU |

Alle drei Regionen halten die Modelle aller vier LLM-Profile als **DataZoneStandard**-Deployment vor (gpt-5.4, gpt-4.1-mini, gpt-5.4-mini, Mistral-Large-3, mistral-small-2503). Verifizierbar mit:

```powershell
az cognitiveservices model list --location germanywestcentral --query "[?contains(model.skus[].name, 'DataZoneStandard')].{name:model.name, format:model.format}" -o table
```

**Compliance-Anker** (Microsoft-Quellen, jährlich aktualisiert — vor Inbetriebnahme prüfen):

- BSI **C5:2020 Typ 2** (Frankfurt): [Service Trust Portal → Germany C5](https://servicetrust.microsoft.com/ViewPage/GermanyC5)
- ISO 27001 / 27017 / 27018, SOC 2 Typ 2: [Service Trust Portal](https://servicetrust.microsoft.com/)
- EU Data Boundary: [learn.microsoft.com/privacy/eudb](https://learn.microsoft.com/privacy/eudb/eu-data-boundary-learn)
- AOAI Modellverfügbarkeit + DataZone-SKUs: [learn.microsoft.com/azure/ai-services/openai/concepts/models](https://learn.microsoft.com/azure/ai-services/openai/concepts/models)

**Architektur-Garantien** (im Code):

- Managed Identity + RBAC für alle Azure-Aufrufe (kein API-Key zu AOAI/Mistral/Vision/Storage)
- Storage hinter VNet + Private Endpoints, Public Access deaktiviert
- Eingaben werden nicht persistiert; Logs enthalten nur Statuscodes/Dauer
- Optional BYOK via Key Vault für externe Secrets (WHO ICD-API) — siehe unten

> Diese Software ist **kein Medizinprodukt** (MDR/IVDR). Die ausgegebenen Codes sind Vorschläge zur Unterstützung des Kodier-Prozesses und müssen durch qualifiziertes Fachpersonal geprüft werden.

> Österreichische Mandanten: Azure Austria East hostet **kein** AOAI (Stand 2026-05-31, verifiziert via `az cognitiveservices model list`). Empfehlung: `germanywestcentral` (DSGVO-konform, geringste Latenz).

---

## LLM-Profile

Die Pipeline ist **provider-neutral** aufgebaut und trennt zwei Rollen:

| Rolle | Wofür | App-Setting |
|---|---|---|
| **Reasoning** | Dual-Classification — Code-Auswahl aus Kandidatenliste, finale Aggregation | `AZURE_OPENAI_DEPLOYMENT_REASONING` *oder* `AZURE_MISTRAL_DEPLOYMENT_REASONING` |
| **Fast** | Term-Extraktion (Pass 1), Sibling-Expansion (Pass 3), optionaler Verifier | `AZURE_OPENAI_DEPLOYMENT_FAST` *oder* `AZURE_MISTRAL_DEPLOYMENT_FAST` |

Der **Provider** wird zur Laufzeit aus den vorhandenen `AZURE_*_ENDPOINT`-Variablen abgeleitet (`AZURE_OPENAI_ENDPOINT` → AOAI, `AZURE_MISTRAL_ENDPOINT` → Mistral). Beide werden über **eine gemeinsame AIServices-Foundry-Ressource** mit OpenAI-kompatiblem `/openai/v1/chat/completions`-Endpoint bedient.

Im 1-Click-Wizard wählen Sie statt einzelner Modelle eines von **vier vorkonfigurierten Profilen**. Alle Profile sind in `germanywestcentral`, `switzerlandnorth` und `swedencentral` verifiziert:

| Profil | Reasoning | Fast | Compliance | Use Case |
|---|---|---|---|---|
| **`aoai-eu`** *(Default)* | `gpt-5.4` — **DataZone** | `gpt-4.1-mini` — **DataZone** | 100 % EU-DataZone | Beste Qualität bei voller EU-Datenresidenz. |
| `aoai-eu-cost` | `gpt-5.4` — **DataZone** | `gpt-5.4-mini` — Global | Mixed (Reasoning EU, Fast Global) | Günstigerer Fast-Tier; Term-Extraktion / Verifier verlassen die EU-DataZone. |
| `mistral-eu` | `Mistral-Large-3` — **DataZone** | `Mistral-Large-3` — **DataZone** *(single model)* | 100 % EU-DataZone + EU-Modellanbieter | Souveränitäts-Anforderung; ein Modell für beide Rollen. Reasoning-Capacity automatisch auf das Account-Quota (~20k TPM, Mai 2026) geklemmt. **Empfohlen für Mistral-Setups**, weil mit Default-Quota produktiv nutzbar. |
| `mistral-eu-cost` | `Mistral-Large-3` — **DataZone** | `mistral-small-2503` — Global | Mixed | EU-Provider + günstigerer Fast-Tier. ⚠️ Out-of-the-box auf den **MaaS-Pool-Default** geklemmt (1 Slot, ≈ 1 TPM für den Fast-Tier) — reicht nur für sehr kurze Texte und führt bei vollen Arztbriefen zum Function-Timeout. Erst nach MaaS-Pool-Quota-Erhöhung produktiv nutzbar. |

Wechsel erfolgt durch **Re-Deploy** (`deploy.ps1 -LlmProfile mistral-eu`) oder durch das Bicep-Parameter `llmProfile` im Wizard. Die HTTP-Schnittstelle der Function App bleibt identisch — kein Code-Eingriff, kein Client-Update nötig.

> **Empfehlung im Zweifel**: `aoai-eu` (Default) oder `mistral-eu` — beide haben mit Default-Quota genug Headroom für volle Arztbriefe. `mistral-eu-cost` setzt eine MaaS-Pool-Quota-Erhöhung voraus.

> Mistral-Endpoints werden in Azure AI Foundry über das **OpenAI-Chat-Completions-kompatible Protokoll** angesprochen; die Provider-Adapter in [shared/llm/](shared/llm/) kapseln URL- und Auth-Unterschiede.

---

## BYOK — Bring Your Own Key

Im Wizard-Tab *BYOK* können statt die WHO-Credentials direkt einzubetten **Key-Vault-Secret-URIs** angegeben werden. Die Function App liest die Werte dann zur Laufzeit per `@Microsoft.KeyVault(SecretUri=...)`-Referenz — die Secret-Werte landen nie im ARM-Deployment-Log und nie in den App-Settings als Plain-Text.

### Setup

```powershell
$kv      = 'kv-icd-klinik1'
$kvRg    = 'rg-keyvault'
$funcRg  = '<deine-funktionsapp-rg>'
$suffix  = '<dein-namesuffix>'

# 1. Key Vault anlegen (RBAC-Modus) und Secrets hinterlegen
az keyvault create -g $kvRg -n $kv --enable-rbac-authorization true --location swedencentral
az keyvault secret set --vault-name $kv -n who-client-id     --value '<WHO_CLIENT_ID>'
az keyvault secret set --vault-name $kv -n who-client-secret --value '<WHO_CLIENT_SECRET>'

# 2. Function App MI Berechtigung geben (Key Vault Secrets User)
$mi   = az functionapp identity show -g $funcRg -n "func-icd-$suffix" --query principalId -o tsv
$kvId = az keyvault show -g $kvRg -n $kv --query id -o tsv
az role assignment create --assignee-object-id $mi --assignee-principal-type ServicePrincipal `
  --role 'Key Vault Secrets User' --scope $kvId

# 3. Die Secret-URIs ablesen
az keyvault secret show --vault-name $kv -n who-client-id     --query id -o tsv
az keyvault secret show --vault-name $kv -n who-client-secret --query id -o tsv
```

Diese beiden URIs in den Wizard-Feldern *Key Vault Secret URI* eintragen. Sind die Felder leer, fallen die Settings zurück auf den Plain-Text-Wert aus dem ICD-11-Tab.

> **Reihenfolge-Tipp**: Sie können das Deployment auch zweistufig fahren — erst ohne BYOK durchziehen (damit die Function-App-MI existiert), dann das Role Assignment auf den KV setzen, dann das Deployment erneut mit den Secret-URIs ausführen. ARM ist idempotent.

---

## Für Newcomer: "Meine erste Azure Landing Zone"

Wenn Sie **noch nie etwas in Azure deployed haben**, sollten Sie *vor* dem 1-Click-Button einmalig eine minimale Landing Zone einrichten. Microsoft liefert Blaupausen — die wichtigsten Einstiegs-Pfade:

| Szenario | Pfad | Aufwand |
|---|---|---|
| **Solo-Klinik / kleine Praxis** — eine Subscription, eine Region, keine On-Prem-Anbindung | [Azure Setup Guide (Quick)](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-setup-guide/) | < 1 h |
| **Kleines Krankenhaus** — Sandbox + Prod, Cost Alerts, ein Admin-Team | [Azure Landing Zone Accelerator — *Sandbox*](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/sovereign/sovereign-landing-zone-portal-deployment-guide) | 2-4 h |
| **Klinik-Verbund / Konzern** — Hub-Spoke, Express Route, mehrere Subscriptions | [Enterprise-Scale Landing Zone (ALZ)](https://github.com/Azure/Enterprise-Scale) | 1-2 Tage |
| **Souveränität & BSI/KRITIS** | [Sovereign Landing Zone](https://github.com/Azure/sovereign-landing-zone) | 1-3 Tage |

Empfohlene **Pflicht-Bausteine** vor produktivem Patientendaten-Workload (egal welcher Pfad):

1. **Microsoft Entra ID Tenant** mit MFA für alle Admins.
2. **Cost Management Budget** auf der Subscription (Alert bei z. B. 100 € / Monat — hilft Lab-Kosten unter Kontrolle zu halten).
3. **Microsoft Defender for Cloud** (Free Tier reicht zum Start) — bekommen Sie Security Recommendations auf alle hier deployten Ressourcen automatisch.
4. **Diagnostic Settings → Log Analytics Workspace** (zentral pro Subscription) — sonst sind Audit-Trails nach 90 Tagen weg.
5. **Tagging-Policy** (z. B. `owner`, `costCenter`, `dataClassification`) — als Azure Policy "Require tag".

Weiterführend:
- [Microsoft Cloud Adoption Framework](https://learn.microsoft.com/azure/cloud-adoption-framework/) — die *kanonische* Quelle.
- [BSI C5-Kriterien & Azure](https://learn.microsoft.com/compliance/regulatory/offering-c5-germany) — relevant für KRITIS-Kliniken.
- [Azure Health Data Services](https://learn.microsoft.com/azure/healthcare-apis/) — falls Sie über FHIR/DICOM-Anbindung nachdenken.

---

## API

Alle Endpoints sind mit `authLevel: function` geschützt → `?code=<FUNCTION_KEY>` mitgeben.

### `GET /api/search`
Einfacher Lookup.

```
GET /api/search?text=cholera&system=icd10gm&limit=10&code=<KEY>
GET /api/search?text=diabetes%20typ%202&system=icd11&limit=10&code=<KEY>
```

### `POST /api/classify`
Dual-Call GPT-Klassifikation. Body-Varianten:

```bash
# Plain text (eine Seite)
curl -X POST "https://<host>/api/classify?system=icd10gm&code=<KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text":"CT-Befund Schädel mit Kontrastmittel"}'

# Mehrere Seiten/Moments
curl -X POST "https://<host>/api/classify?system=icd11&code=<KEY>" \
  -H "Content-Type: application/json" \
  -d '{"moments":[{"text":"...","page":1},{"text":"...","page":2}]}'

# Base64-Datei (PDF/Bild)
curl -X POST "https://<host>/api/classify?code=<KEY>" \
  -H "Content-Type: application/json" \
  -d "{\"file\":\"$(base64 -w0 befund.pdf)\",\"fileContentType\":\"application/pdf\"}"

# Direkter Binär-Upload
curl -X POST "https://<host>/api/classify?code=<KEY>" \
  -H "Content-Type: application/pdf" \
  --data-binary @befund.pdf
```

Response (gekürzt):
```json
{
  "system": "icd10gm",
  "pageCount": 1,
  "classifications": [
    {
      "page": 1,
      "codes": [
        { "code": "...", "display": "...", "confidence": 0.9,
          "verified": true, "verificationMethod": "dual-call-agree", "role": "primary" },
        { "code": "...", "display": "...", "confidence": 0.7,
          "verified": false, "role": "secondary" }
      ]
    }
  ],
  "documentCodes": [
    { "code": "...", "display": "...", "confidence": 0.9, "role": "primary", "pages": [1], "verified": true }
  ],
  "codeSystem": { "system": "icd10gm", "publisher": "BfArM", "version": "2026", ... },
  "candidates": [ ... ],
  "extractedTerms": [ ... ]
}
```

> Pro Seite werden **mehrere Codes** zurückgegeben (Haupt- + Nebendiagnosen / Sekundärkodes), passend zur ICD-10-GM-Mehrfachkodierung. `documentCodes` aggregiert über alle Seiten.

### `GET /api/debug`
HTML-Test-UI mit System-Toggle.

---

## PowerShell-Beispiele

Einmal Setup:

```powershell
$base = 'https://<FUNCTION_APP>.azurewebsites.net'
$key  = az functionapp keys list -g <RESOURCE_GROUP> -n <FUNCTION_APP> --query functionKeys.default -o tsv
```

### Search

```powershell
Invoke-RestMethod "$base/api/search?text=diabetes%20typ%202&system=icd11&limit=5&code=$key"
Invoke-RestMethod "$base/api/search?text=hypertonie&system=icd10gm&limit=5&code=$key"
```

### Classify – Freitext (JSON)

```powershell
$body = @{ text = 'Diabetes mellitus Typ 2 mit Nephropathie, Arterielle Hypertonie Grad 2' } | ConvertTo-Json
$r = Invoke-RestMethod "$base/api/classify?system=icd10gm&code=$key" `
       -Method Post -Body $body -ContentType 'application/json'
$r.documentCodes | Format-Table code, display, confidence, role, verified -AutoSize
$r.extractedTerms
```

### Classify – mehrere Seiten

```powershell
$body = @{ moments = @(
    @{ page = 1; text = 'Hauptdiagnose: STEMI Vorderwand, Z.n. PCI mit Stent' }
    @{ page = 2; text = 'Nebendiagnosen: Diabetes mellitus Typ 2, Adipositas Grad I (BMI 32)' }
) } | ConvertTo-Json -Depth 4
Invoke-RestMethod "$base/api/classify?system=icd11&code=$key" `
    -Method Post -Body $body -ContentType 'application/json' |
    Select-Object -ExpandProperty documentCodes |
    Format-Table code, display, pages -AutoSize
```

### Classify – PDF/Bild als Raw-Binary

```powershell
$pdf = [IO.File]::ReadAllBytes('C:\pfad\zu\Arztbrief.pdf')
$r = Invoke-RestMethod "$base/api/classify?system=icd10gm&code=$key" `
       -Method Post -Body $pdf -ContentType 'application/pdf'
$r.documentCodes | Format-Table code, display, pages -AutoSize
```

### Classify – PDF base64 in JSON

```powershell
$b64  = [Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\pfad\zu\Arztbrief.pdf'))
$body = @{ file = $b64; fileContentType = 'application/pdf' } | ConvertTo-Json
Invoke-RestMethod "$base/api/classify?system=icd11&code=$key" `
    -Method Post -Body $body -ContentType 'application/json' |
    Select-Object system, pageCount, @{n='codes';e={$_.documentCodes.code -join ', '}}
```

**Schalter:** `?system=icd10gm|icd11`, `?languageHint=de` (Default). Im JSON-Body sind `system` / `languageHint` ebenfalls erlaubt und überschreiben den Query-String nicht.

---

## App Settings (Function App)

Vom 1-Click-Wizard bzw. `deploy.ps1` automatisch gesetzt. Im manuellen Setup folgendes berücksichtigen:

### Allgemein

| Key | Pflicht | Beschreibung |
|---|---|---|
| `DEFAULT_SYSTEM` | – | `icd10gm` (Default) oder `icd11` |
| `ICD10GM_VALUESET_URL` | – | Override für die BfArM ValueSet-URL |
| `WHO_ICD_CLIENT_ID` | für ICD-11 | OAuth Client ID (WHO ICD-API) |
| `WHO_ICD_CLIENT_SECRET` | für ICD-11 | OAuth Secret |
| `WHO_ICD_RELEASE` | – | z.B. `2026-01` |
| `WHO_ICD_LANGUAGE` | – | z.B. `de` |
| `WHO_ICD_TOKEN_URL` | – | Override für OAuth-Endpoint (Default `https://icdaccessmanagement.who.int/connect/token`) |
| `WHO_ICD_API_BASE_URL` | – | Override für API-Host (Default `https://id.who.int`) |
| `AZURE_VISION_ENDPOINT` | für PDF/Bild | z.B. `https://<acct>.cognitiveservices.azure.com/` |
| `AZURE_VISION_KEY` | optional | Wenn gesetzt: Key statt MI |

### LLM (Provider-Auto-Detect)

Der Provider wird zur Laufzeit aus genau **einer** der beiden Endpoint-Variablen abgeleitet. Setzen Sie **entweder** den `AZURE_OPENAI_*`- **oder** den `AZURE_MISTRAL_*`-Block, nicht beide.

| Key | Provider | Beschreibung |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | AOAI | z.B. `https://<acct>.openai.azure.com/` |
| `AZURE_OPENAI_DEPLOYMENT` | AOAI | Fallback-Deployment-Name für beide Rollen |
| `AZURE_OPENAI_DEPLOYMENT_REASONING` | AOAI | optional, sonst `AZURE_OPENAI_DEPLOYMENT` |
| `AZURE_OPENAI_DEPLOYMENT_FAST` | AOAI | optional, sonst `AZURE_OPENAI_DEPLOYMENT` |
| `AZURE_OPENAI_REASONING_EFFORT_REASONING` | AOAI | `low` / `medium` (Default) / `high` / `''` |
| `AZURE_OPENAI_REASONING_EFFORT_FAST` | AOAI | dito, optional |
| `AZURE_OPENAI_AUTH_MODE` | AOAI | `rbac` (Default) oder `apikey` |
| `AZURE_OPENAI_API_KEY` | AOAI | nur bei `apikey` |
| `AZURE_MISTRAL_ENDPOINT` | Mistral | AIServices-Endpoint `https://<acct>.cognitiveservices.azure.com/` (gleicher Subdomain-Konvention wie AOAI) |
| `AZURE_MISTRAL_DEPLOYMENT` | Mistral | Fallback-Deployment-Name |
| `AZURE_MISTRAL_DEPLOYMENT_REASONING` | Mistral | optional |
| `AZURE_MISTRAL_DEPLOYMENT_FAST` | Mistral | optional; bei `mistral-eu` (single model) gleich dem REASONING-Wert |
| `AZURE_MISTRAL_AUTH_MODE` | Mistral | `rbac` (Default) oder `apikey` |
| `AZURE_MISTRAL_API_KEY` | Mistral | nur bei `apikey` |

### Settings nach Deploy setzen

```powershell
$rg   = 'rg-icd-classifier'
$func = '<FUNCTION_APP_NAME>'

# WHO-Credentials nachreichen (z.B. wenn beim Deploy noch nicht vorhanden)
az functionapp config appsettings set -g $rg -n $func --settings `
  WHO_ICD_CLIENT_ID='<id>' `
  WHO_ICD_CLIENT_SECRET='<secret>'

# Provider wechseln (Beispiel: von AOAI auf Mistral umschalten)
az functionapp config appsettings delete -g $rg -n $func --setting-names `
  AZURE_OPENAI_ENDPOINT AZURE_OPENAI_DEPLOYMENT AZURE_OPENAI_DEPLOYMENT_REASONING AZURE_OPENAI_DEPLOYMENT_FAST
az functionapp config appsettings set -g $rg -n $func --settings `
  AZURE_MISTRAL_ENDPOINT='https://ai-icd-<suffix>.cognitiveservices.azure.com/' `
  AZURE_MISTRAL_DEPLOYMENT='Mistral-Large-3' `
  AZURE_MISTRAL_AUTH_MODE='rbac'
```

⚠️ **Sicherheit**: WHO-Secrets niemals in Git committen. Lokal: `local.settings.json` (in `.gitignore`).

---

## WHO ICD-API – Registrierung (einmalig)

1. https://icd.who.int/icdapi → Register → einloggen.
2. **API Access → View API access keys → Add new Client**.
3. ClientId + ClientSecret in `WHO_ICD_CLIENT_ID` / `WHO_ICD_CLIENT_SECRET` setzen.
4. Token-Endpoint: `https://icdaccessmanagement.who.int/connect/token` (grant_type=client_credentials, scope=`icdapi_access`) – wird vom Code intern erledigt.

---

## Lokale Entwicklung

```powershell
npm install
copy local.settings.json.example local.settings.json
# Werte eintragen — *entweder* AZURE_OPENAI_* *oder* AZURE_MISTRAL_* (nicht beide),
# Endpoint zeigt jeweils auf das in Azure deployte AIServices-Konto
# (https://ai-icd-<suffix>.cognitiveservices.azure.com/).
# AUTH_MODE=rbac → vorher: az login.
func start
```

Test:
```powershell
curl \"http://localhost:7071/api/search?text=cholera&system=icd10gm&limit=5\"
curl \"http://localhost:7071/api/search?text=diabetes%20typ%202&system=icd11&limit=5\"
```

---

## Deployment (Bicep)

Komplettes Subscription-scoped Deployment via [deploy.ps1](deploy.ps1):

```powershell
az login
# 1-Klick mit Defaults (aoai-eu, Sweden Central, RG 'rg-icd-classifier', Suffix 'icd01')
.\deploy.ps1

# Variante: Frankfurt + Mistral-Profil + APIM-Fassade
.\deploy.ps1 -NameSuffix klinik1 -Location germanywestcentral `
             -LlmProfile mistral-eu `
             -DeployApim -ApimPublisherEmail you@klinik.de
```

Das Skript:
1. liest WHO-Credentials aus `local.settings.json` (gitignored),
2. deployed [infra/main.bicep](infra/main.bicep) inkl. der vier RBAC-Rollenzuweisungen (Vision + LLM + Storage),
3. packt + zip-deployed den Function-Code via Kudu,
4. seedet (wenn `-DeployApim` gesetzt) das APIM-Named-Value `function-key`.

Für reine Infra-Updates / Code-Updates: `-SkipCode` bzw. `-SkipInfra`.

Wenn das LLM-Konto **außerhalb** der RG liegt (z. B. ein bestehendes AIServices-Konto), dem Function-MI manuell die Rolle geben:

```powershell
$mi  = az functionapp identity show -g rg-icd-classifier -n func-icd-<suffix> --query principalId -o tsv
$llm = az cognitiveservices account show -g <llm-rg> -n <llm-account> --query id -o tsv
az role assignment create --assignee-object-id $mi --assignee-principal-type ServicePrincipal `
  --role "Cognitive Services OpenAI User" --scope $llm
```

---

## Architektur

```
shared/
  icdCodeSystem.js          ← Provider-Factory (ICD-10-GM / ICD-11)
  providers/
    icd10gmProvider.js      ← BfArM ValueSet (24h Cache)
    icd11WhoProvider.js     ← WHO ICD-API (OAuth2, Search+Codeinfo Cache)
  llm/
    index.js                ← Provider-Dispatcher (Auto-Detect via AZURE_*_ENDPOINT)
    aoai.js                 ← Azure OpenAI (Reasoning-Effort, RBAC)
    mistral.js              ← Mistral via AI Foundry (OpenAI-kompatibel, RBAC)
  classifyGpt.js            ← Dual-Call Pipeline (provider-agnostisch)
  extract.js                ← Azure AI Vision Read (PDF/Bild)
  auth.js                   ← Managed Identity / DefaultAzureCredential
  http.js                   ← Helpers

search/, classify/, debug/  ← HTTP Functions (authLevel: function)

infra/main.bicep            ← Subscription-scoped Entrypoint
infra/modules/core.bicep    ← Function App + Storage + VNet + Vision + RBAC
infra/modules/llm.bicep     ← AIServices-Konto + Profile-getriebene Deployments
infra/modules/apim.bicep    ← Optionale APIM-Fassade für Low-Code-Konsumenten
```

---

## Copilot Studio / Power Apps Anbindung (APIM)

Für die Anbindung an **Copilot Studio**, **Power Apps** oder andere Low-Code-Tools
wird optional eine **API Management (Consumption-Tier)** Fassade vor die Function App
deployed. Die Fassade exponiert zwei separate APIs – eine pro Klassifikationssystem –,
damit Custom Connectors keinen Query-Parameter `system` setzen müssen.

### Deployment

```powershell
.\deploy.ps1 -NameSuffix klinik1 `
             -DeployApim `
             -ApimPublisherEmail 'du@firma.de'
```

Das Skript:
1. Deployed APIM Consumption + Backend + Policies + Product `icd-classifier` mit zwei APIs (`icd11`, `icd10gm`).
2. Liest nach dem Function-Deploy den Function Key und befüllt damit das APIM Named Value `function-key` (secret). APIM injiziert diesen Wert automatisch als `x-functions-key`-Header in jeden Backend-Call.
3. Gibt am Ende die Gateway-URL und die OpenAPI-Export-URLs aus.

### Requirements (Minimum)

| Was | Wo holen |
|---|---|
| **Subscription Key** | `az apim subscription list -g rg-icd-classifier --service-name apim-icd-<suffix> -o table` → primaryKey via `az apim subscription show … --query primaryKey -o tsv`, oder im Azure-Portal unter *APIM → Subscriptions → icd-classifier*. |
| **OpenAPI-URL (ICD-11)** | `https://apim-icd-<suffix>.azure-api.net/icd11?export=true&format=openapi+json` |
| **OpenAPI-URL (ICD-10-GM)** | `https://apim-icd-<suffix>.azure-api.net/icd10gm?export=true&format=openapi+json` |
| **Auth-Typ** | API Key, Header `Ocp-Apim-Subscription-Key` |

### Custom Connector in Power Apps / Copilot Studio anlegen

1. **Power Apps → Custom Connectors → New → Import OpenAPI from URL** (oder Datei `infra/openapi/icd-api.yaml` hochladen).
2. **Security**: *API Key*, Parameter label `Subscription Key`, Parameter name `Ocp-Apim-Subscription-Key`, Location `Header`.
3. **Host** auf das APIM-Gateway setzen (z. B. `apim-icd-<suffix>.azure-api.net`), Base URL auf `/icd11` bzw. `/icd10gm`.
4. **Test**: `POST /classify` mit Body `{ "text": "Z. n. Myokardinfarkt, art. Hypertonie" }`.
5. In **Copilot Studio** den Connector als Action einbinden – die Codes/Beschreibungen kommen strukturiert zurück.

### Endpunkte (hinter dem APIM)

| Methode | Pfad | Zweck |
|---|---|---|
| `GET`  | `/search?text=…&limit=10` | Volltextsuche (Top-N Treffer mit Score) |
| `POST` | `/classify` | Klassifikation. Body: `{ "text": "…" }` **ODER** `{ "file": "<base64>", "fileContentType": "application/pdf" }` |

Antwort enthält `documentCodes[]` (eindeutige Codes mit `role: primary|secondary|incidental` und `verified`-Flag) sowie `pages[]` (pro OCR-Seite mit `extractedTerms[]`).

### Kosten / Skalierung

- APIM Consumption: **pay-per-call**, ~0,03 €/10k Aufrufe, **keine Idle-Kosten**.
- Rate-Limiting pro Subscription-Key ist im Consumption-Tier **nicht** verfügbar (`rate-limit-by-key` braucht Basic+). Bei Bedarf entweder Tier upgraden oder API-Scope `<rate-limit calls="…" renewal-period="…"/>` (gilt API-weit, nicht pro Konsument).

---

## Hinweise

- **ICD-11**: WHO ICD-API ist lizenziert; nicht-kommerzielle Nutzung frei (siehe WHO-Lizenz).
- **ICD-11 Bulk-Listing**: nicht unterstützt – Provider exponiert nur `search()` + `getCode()`.
- ICD-Codes in der Response stammen ausschließlich aus den Provider-Quellen (BfArM/WHO), niemals direkt aus dem LLM.

---

## Validierung gegen KBV/KVNO-Kodierbeispiele

Goldstandard: **127 reale Fallvignetten** aus offiziellen Quellen, kombiniert in [tests/eval/icd-gold.jsonl](tests/eval/icd-gold.jsonl):

- [KBV Kodierbeispiele](https://www.kbv.de/praxis/abrechnung/kodieren) — Herzinfarkt, Schlaganfall, Bluthochdruckfolgen
- [KVNO/IQN Kodierbeispiele Innere Medizin](https://www.kvno.de/fileadmin/shared/pdf/online/honorar/kodieren/Kodierbeispiele_InnereMedizin.pdf), [Gynäkologie](https://www.kvno.de/fileadmin/shared/pdf/online/honorar/kodieren/Kodierbeispiele_Gynaekologen.pdf), [Psychiatrie](https://www.kvno.de/fileadmin/shared/pdf/online/honorar/kodieren/Kodierbeispiele_Psychiatrie.pdf)

> **Scope:** Die Validierung bezieht sich ausschließlich auf **ICD-10-GM**, da die verfügbaren deutschen Kodierbeispiele nur in dieser Klassifikation vorliegen. Eine analoge Evaluation für ICD-11 MMS würde einen eigenen Goldstandard mit ICD-11-Codes erfordern (z. B. WHO Coding Cases oder ein validiertes ICD-10→ICD-11-Mapping).

Jeder Fall: kurze klinische Vignette + von Fachkodierern vergebenes Code-Set. Metriken sind set-basiert (Mehrfachkodierung), reihenfolge-unabhängig; Zusatzkennzeichen (G/Z/V/A) und Seitenangaben (R/L) werden vor dem Vergleich entfernt.

### Ergebnisse (zero-shot, Dual-Call, n=127)

Zwei Profile gegen den Goldstandard gemessen (lokal `func start`, Sweden Central Deployment, 2026-05-31):

| Metrik | `aoai-eu` (gpt-5.4 reasoning=medium + gpt-4.1-mini) | `mistral-eu` (Mistral-Large-3, single model) |
|---|---:|---:|
| **Avg F1 (full code)** | **0.503** | **0.460** |
| **Avg F1 (3-Steller)** | **0.646** | **0.635** |
| Avg Precision / Recall (full) | 0.561 / 0.501 | 0.455 / 0.529 |
| Avg Precision / Recall (3-Steller) | 0.721 / 0.647 | 0.637 / 0.706 |
| Exact Set Match | **23 / 127** (18 %) | 14 / 127 (11 %) |
| Primary-Code-Hit | 68 / 127 (54 %) | **72 / 127** (57 %) |
| Avg Latenz / Fall | 16.1 s | **13.4 s** |

Per Fachgebiet (F1 3-Steller / Primary-Hit-Rate):

| Fachgebiet | n | `aoai-eu` F1 (stem) | `aoai-eu` Primary | `mistral-eu` F1 (stem) | `mistral-eu` Primary |
|---|---:|---:|---:|---:|---:|
| Innere Medizin   | 84 | 0.65 | 55 % | 0.65 | 56 % |
| Psychiatrie      | 19 | 0.70 | 58 % | 0.56 | 58 % |
| Gynäkologie      | 18 | 0.60 | 39 % | 0.70 | 56 % |
| Herzinfarkt      |  2 | 0.83 | 100 % | 0.50 | 100 % |
| Schlaganfall     |  3 | 0.50 | 67 % | 0.39 | 67 % |
| Bluthochdruckfolgen | 1 | 0.40 | – | 0.33 | – |

Reports werden vom Eval-Skript unter `tests/eval/reports/eval-icd10gm-<timestamp>.md` lokal erzeugt (gitignored — jeder reproduziert die Zahlen gegen den eigenen Deploy, siehe unten).

### Einordnung

Die Zahlen sind auf einem **überschaubaren Goldstandard (n=127)** mit einem **zero-shot LLM-Ansatz ohne Domain-Fine-Tuning** erhoben. Sie sind weder eine Marketing-Botschaft noch ein Bestwert-Anspruch — sondern eine **nachvollziehbare Bezugsgröße**, die jeder mit dem mitgelieferten Skript reproduzieren kann.

Zur groben Verortung gegen die publizierte Literatur für ICD-10-Auto-Coding (Mittelwerte 2022–2025, Micro-F1):

| Ansatz | F1 |
|---|---:|
| GPT zero-shot, generische Prompts (Literatur) | ~0.40 |
| Diese API — `aoai-eu`, 3-Steller | 0.65 |
| Diese API — `mistral-eu`, 3-Steller | 0.64 |
| Diese API — `aoai-eu`, full code | 0.50 |
| Diese API — `mistral-eu`, full code | 0.46 |
| Fine-tuned PLM-ICD / HiLAT (Top-50, MIMIC) | ~0.65 |
| Klinische Kodierer (Inter-Rater-Agreement) | 0.60–0.75 |

<sub>Quellen: Edin et al. 2023 (PLM-ICD), Liu et al. 2022 (HiLAT), Soroush et al. 2024 (GPT-4 ICD zero-shot), O’Malley et al. 2005 (Coder Inter-Rater-Agreement). Werte sind Näherungen, Datensätze und Code-Räume nicht identisch — **nicht 1:1 vergleichbar**, weder mit der Literatur noch mit kommerziellen Anbieter-Benchmarks (die zudem meist auf ICD-10-**CM** in Englisch beruhen).</sub>

**Was diese Implementierung im Kern ausmacht** — jenseits der F1-Zahlen:

- **ICD-10-GM** — die in DE/AT verbindliche, vom BfArM gepflegte Modifikation. Nicht ICD-10-WHO, nicht ICD-10-CM (US). Codes kommen 1:1 aus dem amtlichen ZTS-ValueSet, nicht aus dem Modell.
- **EU-DataZone** als Default — alle Token-Verarbeitung in `germanywestcentral` / `switzerlandnorth` / `swedencentral`, kein Trainings-Opt-In, Managed Identity statt API-Keys.
- **Reproduzierbar** — Goldstandard, Eval-Skript und Reports liegen im Repo. Jeder kann die obigen Zahlen mit einem Befehl gegen den eigenen Deploy nachfahren.
- **Provider-neutral** — Azure OpenAI und Mistral sind austauschbar (Re-Deploy, kein Code-Eingriff). Keine Lock-in-Abhängigkeit von einem einzelnen LLM-Anbieter.
- **Transparente Pipeline** — die drei LLM-Calls (Extraktion + Dual-Klassifikation) sind im Code lesbar, jeder Code im Output ist auf Kandidatenliste und Provider rückverfolgbar.

**Bekannte Limitierungen** des Eval-Setups: (1) Implizite Codes des Goldstandards (z. B. `O09.x` Schwangerschaftsdauer aus SSW-Angabe, Z-Codes für Dauertherapie) sind teils nur über Kodierrichtlinien ableitbar; (2) Regeln zur Mehrfachkodierung (Primär+Sekundär, obligate Begleitcodes) sind im Prompt nicht systematisch hinterlegt; (3) der Datensatz ist nicht repräsentativ über alle ICD-Kapitel.

Reproduzieren:

```powershell
./scripts/eval-classify.ps1 -BaseUrl 'https://<FUNCTION_APP>.azurewebsites.net' `
  -ResourceGroup <RG> -FunctionApp <FUNC> -System icd10gm
```

> Goldstandard: [tests/eval/icd-gold.jsonl](tests/eval/icd-gold.jsonl). Skript: [scripts/eval-classify.ps1](scripts/eval-classify.ps1).

## Kostenabschätzung pro Call (Stand 05/2026)

Die Pipeline ist dreistufig (siehe [shared/classifyGpt.js](shared/classifyGpt.js)):

1. **Term-Extraktion** (1 GPT-Call, Fast-Modell): extrahiert normalisierte Suchbegriffe aus dem Dokument
2. **Provider-Suche** (BfArM-API, kein LLM): liefert Kandidaten-Codes pro Term
3. **Dual-Call-Klassifikation** (2 GPT-Calls, Reasoning-Modell): kontextuell + unabhängig, beschränkt auf die Kandidatenliste

**Token-Budget pro Fall** (typische klinische Vignette, ~80–150 Kandidaten-Codes):

| Phase | Modell-Rolle | Calls | Input-Tk | Output-Tk |
|---|---|:--:|---:|---:|
| Term-Extraktion | Fast | 1 | ~800 | ~400 |
| Klassifikation (Dual-Call) | Reasoning | 2 | ~3.500 ea. | ~600 ea. |
| **Summe pro Fall** | | **3** | **~7.800** | **~1.600** |

**Listenpreise** (Sweden Central / Frankfurt, Mai 2026, [aka.ms/aoaipricing](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/) bzw. [azure.microsoft.com/pricing/details/ai-foundry](https://azure.microsoft.com/pricing/details/ai-foundry/); € / 1 M Tokens):

| Modell | SKU | Input | Output |
|---|---|---:|---:|
| `gpt-5.4`            | DataZoneStandard | ~€1,15 | ~€9,20 |
| `gpt-4.1-mini`       | DataZoneStandard | ~€0,37 | ~€1,47 |
| `gpt-5.4-mini`       | GlobalStandard   | ~€0,14 | ~€0,55 |
| `Mistral-Large-3`    | DataZoneStandard | ~€1,84 | ~€5,52 |
| `mistral-small-2503` | GlobalStandard   | ~€0,18 | ~€0,55 |

> Azure rechnet EU-Abrechnungskonten direkt in EUR ab; obige Werte sind aus den USD-Listpreisen mit ~0,92 €/$ (Mai 2026) umgerechnet. Preise variieren je Region/SKU und ändern sich regelmäßig — bitte aktuelle Werte im Azure-Pricing-Rechner prüfen.

**Kosten pro klassifiziertem Dokument** (mittlere Vignette, ~7.800 Input-Tk + ~1.600 Output-Tk verteilt auf 1 Fast-Call + 2 Reasoning-Calls):

| Profil | Fast (1 Call: 800/400 Tk) | Reasoning (2 Calls: 7.000/1.200 Tk) | **Summe / Dokument** |
|---|---:|---:|---:|
| `aoai-eu`        | ~€0,0009 | ~€0,0190 | **~€0,020** |
| `aoai-eu-cost`   | ~€0,0004 | ~€0,0190 | **~€0,019** |
| `mistral-eu`     | ~€0,0037 | ~€0,0195 | **~€0,023** |
| `mistral-eu-cost`| ~€0,0004 | ~€0,0195 | **~€0,020** |

**Zusätzliche Azure-Kosten** (nicht in obiger Tabelle):
- **BfArM-Provider-API**: kostenlos (öffentlich)
- **WHO ICD-API** (für ICD-11): kostenlos für nicht-kommerzielle Nutzung
- **AI Vision Read** (für PDFs/Bilder): ~€1,38 / 1.000 Transaktionen
- **APIM Consumption**: ~€0,03 / 10k Calls (keine Idle-Kosten)
- **Function App EP1**: Fixkosten ~€165/Monat
- **Storage / Private Endpoint**: ~€9–14/Monat

**Faustregel für 10.000 Arztbriefe à 1 Seite** (Profil `aoai-eu`, mittlere Vignette):
- GPT: 10.000 × €0,020 ≈ **€200**
- Vision Read: 10.000 × €0,00138 ≈ **€14**
- APIM: 10.000 × ~€0,000003 ≈ **€0,03**
- Function/Storage Fixkosten/Monat: ~€185
- **Gesamt: ~€400 / 10k Docs** (variable Kosten dominieren ab ~10k Docs/Monat)

**Eval-Run-Kosten** (n=127 Fallvignetten, je 3 LLM-Calls = 381 Calls insgesamt): ≈ 127 × €0,020 ≈ **€2,55** für `aoai-eu` bzw. ≈ 127 × €0,023 ≈ **€2,95** für `mistral-eu`.
