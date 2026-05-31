'use strict';

const { getEnv } = require('./http');

const COG_SCOPE = 'https://cognitiveservices.azure.com/.default';
const COG_RESOURCE = 'https://cognitiveservices.azure.com/';

let cachedCredential = null;

async function getManagedIdentityTokenDirect(resource = COG_RESOURCE) {
  const identityEndpoint = getEnv('IDENTITY_ENDPOINT');
  const identityHeader = getEnv('IDENTITY_HEADER');
  if (identityEndpoint && identityHeader) {
    const u = new URL(identityEndpoint);
    u.searchParams.set('api-version', '2019-08-01');
    u.searchParams.set('resource', resource);
    const res = await fetch(u.toString(), {
      headers: { 'X-IDENTITY-HEADER': identityHeader, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`MI(IDENTITY_ENDPOINT) HTTP ${res.status}: ${txt.substring(0, 300)}`);
    const data = JSON.parse(txt);
    if (!data?.access_token) throw new Error('MI(IDENTITY_ENDPOINT) missing access_token');
    return data.access_token;
  }

  const msiEndpoint = getEnv('MSI_ENDPOINT');
  const msiSecret = getEnv('MSI_SECRET');
  if (msiEndpoint && msiSecret) {
    const u = new URL(msiEndpoint);
    u.searchParams.set('api-version', '2017-09-01');
    u.searchParams.set('resource', resource);
    const res = await fetch(u.toString(), {
      headers: { Secret: msiSecret, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`MI(MSI_ENDPOINT) HTTP ${res.status}: ${txt.substring(0, 300)}`);
    const data = JSON.parse(txt);
    if (!data?.access_token) throw new Error('MI(MSI_ENDPOINT) missing access_token');
    return data.access_token;
  }

  const imdsUrl = `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`;
  const res = await fetch(imdsUrl, {
    headers: { Metadata: 'true', accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`MI(IMDS) HTTP ${res.status}: ${txt.substring(0, 300)}`);
  const data = JSON.parse(txt);
  if (!data?.access_token) throw new Error('MI(IMDS) missing access_token');
  return data.access_token;
}

async function getCognitiveServicesToken() {
  const looksLikeAzure = !!getEnv('WEBSITE_INSTANCE_ID') || !!getEnv('IDENTITY_ENDPOINT') || !!getEnv('MSI_ENDPOINT');
  if (looksLikeAzure) {
    return await getManagedIdentityTokenDirect(COG_RESOURCE);
  }
  // Local dev: DefaultAzureCredential (az login / VS Code)
  // eslint-disable-next-line global-require
  const { DefaultAzureCredential } = require('@azure/identity');
  if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
  const token = await cachedCredential.getToken(COG_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire Entra ID token for Cognitive Services');
  return token.token;
}

module.exports = {
  getCognitiveServicesToken,
  COG_SCOPE,
  COG_RESOURCE,
};
