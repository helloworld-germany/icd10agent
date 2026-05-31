// Reproduces the EXACT shared/extract.js logic, but uses a token passed in via
// the VISION_TOKEN env var. Run with:
//   $env:VISION_TOKEN = (az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv)
//   $env:VISION_ENDPOINT = "https://cv-icd-icd1011c.cognitiveservices.azure.com"
//   node scripts/repro-vision.js "\\Kellergehirn\Markus\Arbeit\Microsoft\Projekte\Beispiele\Arztbrief Bandscheibe.pdf"

'use strict';
const fs = require('fs');

const READ_API_VERSION = '2024-02-01'; // unused, kept for parity with extract.js
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 60_000;

const endpoint = process.env.VISION_ENDPOINT || 'https://cv-icd-icd1011c.cognitiveservices.azure.com';
const token = process.env.VISION_TOKEN;
if (!token) throw new Error('VISION_TOKEN env var required');

const authHeaders = { Authorization: `Bearer ${token}` };

async function submitRead(bytes, contentType) {
  const url = `${endpoint.replace(/\/+$/, '')}/vision/v3.2/read/analyze`;
  const headers = { ...authHeaders, 'content-type': contentType || 'application/octet-stream' };
  const res = await fetch(url, { method: 'POST', headers, body: bytes });
  console.log('[submit] status=', res.status, 'op-loc=', res.headers.get('operation-location'));
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Vision Read submit HTTP ${res.status}: ${txt.substring(0, 300)}`);
  }
  return res.headers.get('operation-location');
}

async function pollRead(opLocation) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    attempt++;
    const res = await fetch(opLocation, { headers: authHeaders });
    const data = await res.json().catch(() => ({}));
    const status = data?.status || data?.analyzeResult?.status;
    console.log(`[poll ${attempt}] http=${res.status} status=${status} elapsed=${Date.now()-start}ms`);
    if (status === 'succeeded') return data;
    if (status === 'failed') throw new Error('Read failed: ' + JSON.stringify(data).substring(0, 300));
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Vision Read timeout');
}

function extractPages(readResult) {
  const pages = readResult?.analyzeResult?.readResults || [];
  console.log('[extract] readResults.length=', pages.length);
  pages.forEach((p, i) => {
    const linesCount = (p.lines || []).length;
    const sample = (p.lines || []).slice(0, 2).map(l => l.text).join(' | ');
    console.log(`[extract] page ${i+1}: page-field=${p.page} lines=${linesCount} sample="${sample}"`);
  });
  return pages.map((p, idx) => ({
    page: p.page || idx + 1,
    text: (p.lines || []).map(l => l.text).join('\n').trim(),
  })).filter(p => p.text);
}

(async () => {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node repro-vision.js <pdfPath>');
  const bytes = fs.readFileSync(path);
  console.log('[main] file bytes=', bytes.length);
  const op = await submitRead(bytes, 'application/pdf');
  const result = await pollRead(op);
  const pages = extractPages(result);
  console.log('[main] FINAL pages.length=', pages.length);
  console.log('[main] FINAL pages text length per page:', pages.map(p => p.text.length));
  if (pages.length) console.log('[main] page 1 first 200 chars:', pages[0].text.substring(0, 200));
})().catch(err => { console.error('[main] ERROR:', err.message); process.exit(1); });
