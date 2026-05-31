'use strict';

const { getEnv } = require('../http');

const DEFAULT_TOKEN_URL = 'https://icdaccessmanagement.who.int/connect/token';
const DEFAULT_API_BASE_URL = 'https://id.who.int';
const SCOPE = 'icdapi_access';
const SEARCH_CACHE_MS = 15 * 60 * 1000; // 15 min per-query cache
const ENTITY_CACHE_MS = 24 * 60 * 60 * 1000;

let cachedToken = null;           // { token, expiresAt }
const searchCache = new Map();    // key -> { at, data }
const entityCache = new Map();    // code -> { at, data }

function release() { return getEnv('WHO_ICD_RELEASE', '2026-01'); }
function language() { return getEnv('WHO_ICD_LANGUAGE', 'de'); }
function tokenUrl() { return getEnv('WHO_ICD_TOKEN_URL', DEFAULT_TOKEN_URL); }
function apiBaseUrl() { return (getEnv('WHO_ICD_API_BASE_URL', DEFAULT_API_BASE_URL) || '').replace(/\/+$/, ''); }

// Build base path under id.who.int. Empty release => "latest" (required for some languages, e.g. German).
function mmsBase() {
  const rel = release();
  return rel ? `/icd/release/11/${rel}/mms` : `/icd/release/11/mms`;
}
function codeinfoBase() {
  const rel = release();
  return rel ? `/icd/release/11/${rel}/codeinfo` : `/icd/release/11/codeinfo`;
}

async function getToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;

  const clientId = getEnv('WHO_ICD_CLIENT_ID');
  const clientSecret = getEnv('WHO_ICD_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('WHO_ICD_CLIENT_ID / WHO_ICD_CLIENT_SECRET not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: SCOPE,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`WHO token HTTP ${res.status}: ${txt.substring(0, 300)}`);
  const data = JSON.parse(txt);
  if (!data?.access_token) throw new Error('WHO token response missing access_token');
  const ttl = (data.expires_in || 3600) * 1000;
  cachedToken = { token: data.access_token, expiresAt: now + ttl };
  return cachedToken.token;
}

async function whoFetch(pathAndQuery) {
  const token = await getToken();
  const url = `${apiBaseUrl()}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': language(),
      'API-Version': 'v2',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`WHO ${pathAndQuery} HTTP ${res.status}: ${txt.substring(0, 300)}`);
  return JSON.parse(txt);
}

function stripHtml(s) {
  return (s || '').toString().replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function meta() {
  const rel = release() || 'latest';
  return {
    system: 'icd11',
    publisher: 'WHO',
    release: rel,
    language: language(),
    title: `ICD-11 MMS (WHO, release ${rel}, ${language()})`,
    source: `${apiBaseUrl()}${mmsBase()}`,
  };
}

async function search(query, limit = 10) {
  const q = (query || '').toString().trim();
  if (!q) return { meta: meta(), results: [] };
  const key = `${release()}|${language()}|${limit}|${q.toLowerCase()}`;
  const now = Date.now();
  const hit = searchCache.get(key);
  if (hit && (now - hit.at) < SEARCH_CACHE_MS) return hit.data;

  const qs = new URLSearchParams({
    q,
    useFlexisearch: 'true',
    flatResults: 'true',
    highlightingEnabled: 'false',
  });
  const data = await whoFetch(`${mmsBase()}/search?${qs.toString()}`);

  const entities = data?.destinationEntities || [];
  const results = entities.slice(0, limit).map(e => ({
    code: e.theCode || null,
    display: stripHtml(e.title) || null,
    id: e.id || null,
    score: typeof e.score === 'number' ? +e.score.toFixed(3) : null,
    chapter: e.chapter || null,
  })).filter(r => r.code || r.id);

  const payload = { meta: meta(), results };
  searchCache.set(key, { at: now, data: payload });
  return payload;
}

async function getCode(code) {
  const c = (code || '').toString().trim();
  if (!c) return { meta: meta(), result: null };
  const now = Date.now();
  const hit = entityCache.get(c);
  if (hit && (now - hit.at) < ENTITY_CACHE_MS) return { meta: meta(), result: hit.data };

  // codeinfo endpoint resolves a code to its entity URI
  let entityId = null;
  try {
    const info = await whoFetch(`${codeinfoBase()}/${encodeURIComponent(c)}`);
    entityId = info?.stemId || info?.['@id'] || null;
  } catch (_) {
    // try direct path fallback
  }

  let entity = null;
  if (entityId) {
    const path = new URL(entityId).pathname;
    entity = await whoFetch(path);
  }

  const result = entity ? {
    code: c,
    display: stripHtml(entity?.title?.['@value'] || entity?.title || ''),
    definition: stripHtml(entity?.definition?.['@value'] || ''),
    id: entity?.['@id'] || entityId,
    parent: entity?.parent || [],
    child: entity?.child || [],
  } : null;

  entityCache.set(c, { at: now, data: result });
  return { meta: meta(), result };
}

async function listAll() {
  // ICD-11 is not bulk-listed via this provider (way too large + license).
  return { meta: meta(), count: null, results: null, note: 'ICD-11 bulk listing not supported; use search().' };
}

module.exports = { search, getCode, listAll };
