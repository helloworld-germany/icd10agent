# ICD-10-GM Free Text → Code (Azure Static Web Apps)

Minimal prototype: single-page HTML + an Azure Static Web Apps Function.

- UI: `index.html`
- API: `GET /api/search?text=...&limit=...` (or still `q=...`)
- ICD codes come exclusively from the BfArM ZTS source (ICD-10-GM ValueSet “terminal codes”), never from the model.

## Data Source

Upstream (BfArM ZTS, free to access):

- https://terminologien.bfarm.de/rendering_data/ValueSet-icd10gm-terminale-codes-2026.json

The Function fetches this JSON server-side and caches it in-memory (24h) so the browser does not run into CORS issues.

## Deploy as Azure Static Web App (GitHub → Azure)

Goal: after `git push`, the deployment runs automatically.

### Lowest interaction (CLI-only): create + link SWA in one command

If you want to avoid the Azure Portal/VS Code UI entirely, you can create the Static Web App *and* link it to your GitHub repo from the CLI. Azure will then create the GitHub Actions workflow under `.github/workflows/` and the required secret automatically.

Copy/paste cookbook (first-time setup):

1) Sign in to Azure:

`az login`

2) Install the SWA CLI extension (one-time):

`az extension add --name staticwebapp`

3) Create the resource group (one-time):

`az group create --name icd10agent --location westeurope`

4) Create the Static Web App and link it to this GitHub repo (interactive GitHub OAuth; no token copy/paste):

`az staticwebapp create --name icd10agent --resource-group icd10agent --location westeurope --source https://github.com/helloworld-germany/icd10agent --branch main --app-location / --api-location api --login-with-github`

Note: the SWA name must be globally unique. If `icd10agent` is already taken, pick a different name and use it consistently in the commands below.

What this does:

- Creates the SWA resource in Azure.
- Adds a GitHub Actions workflow file into your repo (under `.github/workflows/`).
- Creates the required GitHub secret automatically.

Git note (important): because Azure creates a commit in your repo before your first push, you usually need to pull once before pushing your local commits.

5) Git: make sure you are on `main`, pull the Azure-created workflow commit, then push:

`git branch -M main`

If you don’t have an `origin` remote yet:

`git remote add origin https://github.com/helloworld-germany/icd10agent.git`

`git fetch origin`

`git branch --set-upstream-to=origin/main main`

`git pull --rebase`

`git push`

If `git pull --rebase` complains about unrelated histories, use:

`git pull origin main --allow-unrelated-histories`

After that, every `git push` to `main` triggers a deployment.

6) Get the browser URL (no portal needed):

`az staticwebapp show -n icd10agent -g icd10agent --query defaultHostname -o tsv`

Open:

`https://DEFAULT_HOSTNAME`

First-deploy note: it’s normal to briefly see the default “Congratulations on your new site!” placeholder page until the first GitHub Actions deployment finishes and the CDN content propagates (often 1–3 minutes). A hard refresh after the workflow run succeeded usually fixes it.

If you want to verify from the CLI:

`curl -sS https://DEFAULT_HOSTNAME/ | head`

### Option A (recommended): Azure/VS Code sets up GitHub automatically (no token copy/paste)

This option links the GitHub repo via OAuth and automatically creates the required GitHub secrets/workflow files (no manual token handling).

**A1: VS Code extension (minimal portal clicking)**

- Install/use the **Azure Static Web Apps** extension.
- In VS Code: `F1` → **Azure Static Web Apps: Create static web app...**
- You will be prompted to sign in to **Azure and GitHub**.
- Select your repo/branch (`main`) and set build paths for this repo:
   - App location: `/`
   - API location: `api`
   - Output location: empty

**A2: Azure Portal**

- Azure Portal → **Static Web Apps** → Create
- Source: **GitHub** → select repo/branch and set the same build paths (`/`, `api`, output empty).

**A3: ARM creates the SWA, Portal/VS Code links the repo (typical for this repo)**

- First deploy the SWA via ARM (see below).
- Then: Azure Portal (or VS Code extension) → your Static Web App → configure GitHub/Deployment → select repo/branch.
- Azure will create a workflow file under `.github/workflows/` and a matching secret (names can vary by app).

After that, pushes to `main` automatically trigger deployments.

### Option B (fallback): Manual deployment token

If you cannot/do not want to link via OAuth, you can still use a deployment token as a GitHub secret and maintain your own workflow. (This repo intentionally does not ship a token-based workflow so you don’t have to copy tokens.)

## Infrastructure-as-Code (ARM)

ARM templates live under `infra/` and reproducibly create:

- Resource group: `icd10agent`
- Azure Static Web App (SWA) on the Free tier

Note: the SWA name must be **globally unique**.

### Deploy via Azure CLI

1) Adjust the parameter file (at least `staticSiteName`): `infra/parameters.json`

2) Run the subscription-scope deployment (creates the RG and deploys SWA into it):

`az deployment sub create --location westeurope --template-file infra/subscription.json --parameters @infra/parameters.json`

Then: Azure Portal (or VS Code extension) → your Static Web App → configure GitHub/Deployment (Option A). Azure will create workflow + secret automatically.

Fallback (Option B): set a deployment token as a GitHub secret and use your own workflow.

## API Quick Check

After deployment, these should work:

- `/api/search?text=cholera&limit=5`
- (optional) `/api/search?q=cholera&limit=5`

## Note on GPT / AI Foundry

The Function optionally supports GPT-5.2 (Azure OpenAI / AI Foundry) **only** to prepare/normalize the free-text into a short search query.

By default, GPT is **NOT active** until you configure Azure OpenAI settings (so deployments stay “free by default” unless you explicitly enable it).

- ICD codes in the response still come **only** from the BfArM dataset (never from the model).
- If Azure OpenAI is not configured (or temporarily failing), `text` is used directly as the search query (no LLM call). In that case `usedLLM` is `false` and the API may include `llmError` for debugging.

### Enable GPT in the deployed SWA (CLI-only, RBAC)

Copy/paste cookbook (PowerShell, **RBAC only**, no API keys):

1) Set variables (paste this **first** into PowerShell, then copy/paste the rest of the steps in the **same terminal session**):

`$rg = "icd10agent"`

If you don’t know your Static Web App name yet, list it and pick one:

`az staticwebapp list -g $rg --query "[].name" -o tsv`

Then set it:

`$swa = "PASTE_YOUR_SWA_NAME_HERE"`

If you don’t know your Azure OpenAI account name yet, list it (note `name` + `resourceGroup`):

`az cognitiveservices account list --query "[?kind=='OpenAI'].{name:name,resourceGroup:resourceGroup,location:location}" -o table`

Then set:

`$openAiRg = "icd10agent"; $openAiAccount = "PASTE_YOUR_OPENAI_ACCOUNT_NAME_HERE"; $openAiDeployment = "gpt-52"`

2) Make sure the Static Web App supports Managed Identity (**Free does not**):

`az staticwebapp show -n $swa -g $rg --query sku.name -o tsv`

If it prints `Free`, upgrade (this may incur cost):

`az staticwebapp update -n $swa -g $rg --sku Standard`

3) Enable the Static Web App managed identity:

`az staticwebapp identity assign -n $swa -g $rg`

`$principalId = az staticwebapp identity show -n $swa -g $rg --query principalId -o tsv`

4) (If needed) create the Azure OpenAI deployment for GPT-5.2 Chat:

List what your account supports (model versions + deployment SKUs vary by region/quota):

`az cognitiveservices account list-models -g $openAiRg -n $openAiAccount -o jsonc`

Create a deployment (example values from `list-models` output):

`$modelVersion = "2026-02-10"; $deploymentSku = "GlobalStandard"`

`az cognitiveservices account deployment create -g $openAiRg -n $openAiAccount --deployment-name $openAiDeployment --model-format OpenAI --model-name gpt-5.2-chat --model-version $modelVersion --sku-name $deploymentSku --sku-capacity 1`

If you already created the deployment successfully, you can skip this step.

5) Grant the SWA identity RBAC access to Azure OpenAI:

`$openAiId = az cognitiveservices account show -g $openAiRg -n $openAiAccount --query id -o tsv`

`az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role "Cognitive Services OpenAI User" --scope $openAiId`

Note: Many Azure OpenAI accounts are created with `disableLocalAuth=true` (no API keys). In that case RBAC is required for GPT to work.

RBAC propagation can take a minute. If the next step fails with a permissions error, retry after ~60–120 seconds.

6) Configure the SWA Function app settings:

`$openAiEndpoint = az cognitiveservices account show -g $openAiRg -n $openAiAccount --query properties.endpoint -o tsv`

Important: `properties.endpoint` may look like `https://<region>.api.cognitive.microsoft.com/`. For the OpenAI-compatible API used by this repo, set the base URL explicitly:

`$openAiBaseUrl = "https://$openAiAccount.openai.azure.com/openai/v1/"`

`az staticwebapp appsettings set -n $swa -g $rg --setting-names AZURE_OPENAI_ENDPOINT=$openAiEndpoint AZURE_OPENAI_BASE_URL=$openAiBaseUrl AZURE_OPENAI_DEPLOYMENT=$openAiDeployment AZURE_OPENAI_AUTH_MODE=rbac`

Sanity check (keys should exist; values may be redacted):

`az staticwebapp appsettings list -n $swa -g $rg --query "{AZURE_OPENAI_ENDPOINT:properties.AZURE_OPENAI_ENDPOINT,AZURE_OPENAI_BASE_URL:properties.AZURE_OPENAI_BASE_URL,AZURE_OPENAI_DEPLOYMENT:properties.AZURE_OPENAI_DEPLOYMENT,AZURE_OPENAI_AUTH_MODE:properties.AZURE_OPENAI_AUTH_MODE}" -o jsonc`

7) Verify (you should see `usedLLM : true`):

`$hostName = az staticwebapp show -n $swa -g $rg --query defaultHostname -o tsv`

`$hostName`

PowerShell note: on Windows, `curl` is often an alias for `Invoke-WebRequest`. Use `Invoke-RestMethod` (recommended) or `curl.exe` explicitly.

`Invoke-RestMethod "https://$hostName/api/search?text=diabetes%20mellitus%20typ%202&limit=5" | Format-List input,query,usedLLM,count`

Alternative:

`curl.exe -sS "https://$hostName/api/search?text=diabetes%20mellitus%20typ%202&limit=5" | ConvertFrom-Json | Format-List input,query,usedLLM,count`

If `usedLLM` stays `false`, double-check that you called with `text=...` (not `q=...`) and that the three app settings were applied.

If the request fails with HTTP 500, show the Function’s error payload:

`try { Invoke-RestMethod "https://$hostName/api/search?text=diabetes%20mellitus%20typ%202&limit=5" } catch { $_.ErrorDetails.Message }`

If the response includes `llmError` mentioning `ManagedIdentityCredential` / `DefaultAzureCredential`, the Function could not acquire an Entra ID token. Quick checks:

- Confirm SWA is `Standard`: `az staticwebapp show -n $swa -g $rg --query sku.name -o tsv`
- Confirm identity is assigned (principalId not empty): `az staticwebapp identity show -n $swa -g $rg -o jsonc`
- Confirm the role assignment exists (may take a minute to appear): `az role assignment list --assignee $principalId --scope $openAiId -o table`

If `llmError` includes something like `Cannot read properties of undefined (reading 'expires_on')`, that’s a managed identity token parsing issue in some runtimes. This repo works around it by calling the managed identity endpoint directly; redeploy by pushing your latest commit and retry the verify step.

If `llmError` includes `Managed identity (IDENTITY_ENDPOINT) fetch failed` / `Managed identity (MSI_ENDPOINT) fetch failed` / `Managed identity (IMDS) fetch failed`, the Functions runtime likely does **not** expose managed identity token endpoints to the API container (even if the SWA resource has an identity).

In that case, the reliable RBAC-only option is to host the API as a separate Azure Function App (or similar compute) with managed identity and call it from the static site.

### SWA App Settings (RBAC / Entra ID)

For RBAC-based auth (no API keys), the Function uses `DefaultAzureCredential` and requests tokens for scope `https://cognitiveservices.azure.com/.default`.

If you deploy with `enableOpenAI=true`, `infra/subscription.json` automatically sets the required **Function App settings** (via `Microsoft.Web/staticSites/config` → `functionappsettings`):

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_AUTH_MODE=rbac`

You can override/add these in the Azure Portal under Static Web App → Configuration.

Optional:

- `AZURE_OPENAI_BASE_URL` (if you want to set `https://<account>.openai.azure.com/openai/v1/` directly; otherwise `/openai/v1/` is derived from `AZURE_OPENAI_ENDPOINT`)

For this to work in Azure, the executing identity needs an appropriate RBAC role on the Azure OpenAI resource (or at least on the resource group).

**ARM:** In `infra/subscription.json`, you can optionally set `openAIRoleDefinitionId` to create a role assignment for the Static Web App’s system-assigned identity.

Example (get the role definition ID):

`az role definition list --name "Cognitive Services OpenAI User" --query "[0].id" -o tsv`

Put that ID into `infra/parameters.json` under `openAIRoleDefinitionId.value`.
