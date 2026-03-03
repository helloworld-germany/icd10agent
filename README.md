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

### Simplest “no Azure prep” path (recommended): GitHub Actions creates everything

You can make this repo self-provisioning:

- On every push to `main`, GitHub Actions will:
   - create/update the Azure resource group and the Static Web App via ARM
   - fetch a fresh SWA deployment token from Azure (management plane)
   - deploy the app + API

This avoids manual token copy/paste.

#### One-time bootstrap (required)

There is one hard technical minimum: a workflow must be able to authenticate to Azure.
This repo uses GitHub OIDC (no long-lived secrets). You run a one-time bootstrap locally to create the Entra ID app + federated credential and set GitHub repo variables.

Prereqs (local, one-time):

- `az login`
- `gh auth login`

Run:

`powershell -ExecutionPolicy Bypass -File scripts/bootstrap-oidc.ps1 -Repo helloworld-germany/icd10agent -StaticSiteName icd10agent`

Then push to `main` and the workflow in `.github/workflows/deploy.yml` will provision + deploy.

Notes:

- The SWA name must be globally unique. If `icd10agent` is taken, change the GitHub repo variable `STATIC_SITE_NAME`.
- The bootstrap assigns `Contributor` at subscription scope (because the RG does not exist yet). If you want tighter scope, create the RG first and scope RBAC to that RG.

### Lowest interaction (CLI-only): create + link SWA in one command

If you want to avoid the Azure Portal/VS Code UI entirely, you can create the Static Web App *and* link it to your GitHub repo from the CLI. Azure will then create the GitHub Actions workflow under `.github/workflows/` and the required secret automatically.

Prereqs:

- Azure CLI logged in: `az login`
- GitHub CLI logged in (so Azure CLI can access the repo): `gh auth login`
- Azure CLI extension (one-time): `az extension add --name staticwebapp`

Create the resource group (one-time):

`az group create --name icd10agent --location westeurope`

Then run (replace placeholders):

`az staticwebapp create --name <STATIC_SITE_NAME> --resource-group icd10agent --location westeurope --source https://github.com/<OWNER>/<REPO> --branch main --app-location / --api-location api --login-with-github`

Notes:

- You need sufficient permissions on the GitHub repo (typically admin/write) because Azure will add a workflow file.
- After this, a normal `git push` to `main` triggers the deployment.

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

- ICD codes in the response still come **only** from the BfArM dataset (never from the model).
- If Azure OpenAI is not configured, `text` is used directly as the search query (no LLM call).

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
