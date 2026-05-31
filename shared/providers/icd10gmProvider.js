'use strict';

const { getEnv } = require('../http');

const DEFAULT_URL = 'https://terminologien.bfarm.de/rendering_data/ValueSet-icd10gm-terminale-codes-2026.json';
const CACHE_MS = 24 * 60 * 60 * 1000;

let cached = null;     // { index, meta, at }

function normalizeText(value) {
  return (value || '')
    .toString()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\.\-\s]/g, ' ')
    // Split letter/digit boundaries so "typ2" → "typ 2", "grad3" → "grad 3",
    // "icd10" → "icd 10". Generic, not query-specific.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(norm) {
  const stop = new Set([
    'und', 'oder', 'mit', 'ohne', 'der', 'die', 'das', 'des', 'dem', 'den',
    'im', 'in', 'am', 'an', 'auf', 'bei', 'fur', 'von', 'zu', 'zum', 'zur',
    'eine', 'einer', 'eines', 'ein', 'nicht', 'näher', 'bezeichnet',
  ]);
  return norm.split(' ')
    .map(t => t.trim())
    .filter(t => t.length > 0 && !stop.has(t))
    // keep all numeric tokens (Typ 1/2, Grad 1/2/3, Stadium 3 ...)
    // and alpha tokens of length >= 3
    .filter(t => /^\d+$/.test(t) || t.length >= 3);
}

function buildRows(rawRows) {
  return rawRows
    .filter(r => r && typeof r.Code === 'string' && typeof r.Display === 'string')
    .map(r => ({
      code: r.Code,
      display: r.Display,
      normCode: normalizeText(r.Code),
      normDisplay: normalizeText(r.Display),
    }));
}

function scoreRow(row, qNorm, qTokens) {
  let score = 0;
  if (/^[a-z][0-9]{2}(\.[0-9a-z])?/.test(qNorm)) {
    if (row.normCode === qNorm) score += 100;
    else if (row.normCode.startsWith(qNorm)) score += 60;
  }
  if (qNorm && row.normDisplay.includes(qNorm)) score += 12;
  // Per-token contribution: numeric tokens (1, 2, 3) are *highly* discriminative
  // for typing/grading codes; weight them much higher than alpha tokens.
  for (const t of qTokens) {
    const isNum = /^\d+$/.test(t);
    if (isNum) {
      // require word-boundary match for digits so "2" doesn't match "20"/"22"
      const re = new RegExp(`(^|[^0-9])${t}([^0-9]|$)`);
      if (re.test(row.normDisplay)) score += 10;
    } else if (row.normDisplay.includes(t)) {
      score += 4;
    }
  }
  // Penalize unmatched key digits in display when query has them (helps Typ 1 vs Typ 2)
  for (const t of qTokens) {
    if (!/^\d+$/.test(t)) continue;
    const otherDigits = (row.normDisplay.match(/\b\d+\b/g) || []).filter(d => d !== t && Number(d) < 10);
    if (otherDigits.length) score -= 3;
  }
  score += Math.min(row.code.length, 8) * 0.01;
  return score;
}

async function loadFromUpstream() {
  const url = getEnv('ICD10GM_VALUESET_URL', DEFAULT_URL);
  // BfArM is a public endpoint and can be slow; cap network at 60s.
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`BfArM fetch HTTP ${res.status}`);
  const data = await res.json();
  // BfArM rendering_data shape: { rows: [{Code, System, Display}, ...] }
  // FHIR ValueSet fallback: expansion.contains [{code, display}] or compose.include[0].concept
  const rawRows =
    (Array.isArray(data?.rows) && data.rows) ||
    data?.expansion?.contains ||
    data?.compose?.include?.[0]?.concept ||
    [];
  const mapped = rawRows.map(r => ({
    Code: r.Code || r.code,
    Display: r.Display || r.display,
  }));
  return {
    rows: buildRows(mapped),
    meta: {
      system: 'icd10gm',
      url,
      version: data?.version || '2026',
      title: data?.title || 'ICD-10-GM (BfArM terminale Codes)',
      date: data?.date || null,
      publisher: 'BfArM',
    },
  };
}

async function getIndex() {
  const now = Date.now();
  if (cached && (now - cached.at) < CACHE_MS) return cached;
  try {
    const { rows, meta } = await loadFromUpstream();
    cached = { index: rows, meta, at: now };
    return cached;
  } catch (e) {
    if (cached) return cached; // serve stale on upstream error
    // Optional bundled fallback
    try {
      const fallback = require('../../config/codesystem-icd10gm-fallback.json');
      const mapped = (fallback.rows || []).map(r => ({ Code: r.Code || r.code, Display: r.Display || r.display }));
      cached = {
        index: buildRows(mapped),
        meta: {
          system: 'icd10gm',
          url: 'bundled-fallback',
          version: fallback.version || 'fallback',
          title: 'ICD-10-GM (bundled fallback)',
          date: null,
          publisher: 'BfArM',
        },
        at: now,
      };
      return cached;
    } catch (_) {
      throw e;
    }
  }
}

async function search(query, limit = 10) {
  const { index, meta } = await getIndex();
  const qNorm = normalizeText(query || '');
  const qTokens = tokenize(qNorm);
  if (!qNorm) return { meta, results: [] };
  const scored = [];
  for (const row of index) {
    const s = scoreRow(row, qNorm, qTokens);
    if (s > 0) scored.push({ code: row.code, display: row.display, score: +s.toFixed(3) });
  }
  scored.sort((a, b) => b.score - a.score);
  return { meta, results: scored.slice(0, limit) };
}

async function getCode(code) {
  const { index, meta } = await getIndex();
  const norm = normalizeText(code);
  const hit = index.find(r => r.normCode === norm);
  if (!hit) return { meta, result: null };
  return { meta, result: { code: hit.code, display: hit.display } };
}

async function listAll(limit = 0) {
  const { index, meta } = await getIndex();
  return {
    meta,
    count: index.length,
    results: limit > 0 ? index.slice(0, limit).map(r => ({ code: r.code, display: r.display })) : null,
  };
}

module.exports = { search, getCode, listAll };
