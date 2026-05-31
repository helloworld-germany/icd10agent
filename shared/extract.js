'use strict';

const { getEnv } = require('./http');
const { getCognitiveServicesToken } = require('./auth');

const READ_API_VERSION = '2024-02-01';
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 60_000;

function visionEndpoint() {
  const ep = getEnv('AZURE_VISION_ENDPOINT');
  if (!ep) throw new Error('AZURE_VISION_ENDPOINT not configured');
  return ep.replace(/\/+$/, '');
}

async function visionAuthHeaders() {
  const apiKey = getEnv('AZURE_VISION_KEY');
  if (apiKey) return { 'Ocp-Apim-Subscription-Key': apiKey };
  const token = await getCognitiveServicesToken();
  return { Authorization: `Bearer ${token}` };
}

async function submitRead(bytes, contentType) {
  const url = `${visionEndpoint()}/vision/v3.2/read/analyze`;
  const headers = {
    ...(await visionAuthHeaders()),
    'content-type': contentType || 'application/octet-stream',
  };
  // 30s upper bound: submit is usually <1s; anything longer is a hung connection.
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Vision Read submit HTTP ${res.status}: ${txt.substring(0, 300)}`);
  }
  const opLocation = res.headers.get('operation-location');
  if (!opLocation) throw new Error('Vision Read: missing operation-location');
  return opLocation;
}

async function pollRead(opLocation) {
  const headers = await visionAuthHeaders();
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(opLocation, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const status = data?.status || data?.analyzeResult?.status;
    if (status === 'succeeded') return data;
    if (status === 'failed') throw new Error(`Vision Read failed: ${JSON.stringify(data).substring(0, 300)}`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Vision Read timeout');
}

function extractPages(readResult) {
  const pages = readResult?.analyzeResult?.readResults || [];
  return pages.map((p, idx) => ({
    page: p.page || idx + 1,
    text: (p.lines || []).map(l => l.text).join('\n').trim(),
  })).filter(p => p.text);
}

async function extractFromFile(bytes, contentType) {
  const opLocation = await submitRead(bytes, contentType);
  const result = await pollRead(opLocation);
  return extractPages(result);
}

module.exports = { extractFromFile };
