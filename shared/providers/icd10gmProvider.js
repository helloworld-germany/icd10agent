'use strict';

const { getEnv } = require('../http');

// Default: BfArM rendering_data CodeSystem — contains all properties
// (usage = dagger/aster/optional, Para301/Para295 = §301/§295 SGB V
// Hauptdiagnose-Befugnis, classKind, parent/child hierarchy, age/sex
// reject). Legacy: ValueSet shape contains only Code+Display.
const DEFAULT_URL = 'https://terminologien.bfarm.de/rendering_data/CodeSystem-icd10gm-2026.json';
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
    // Only `category` rows are codable diagnoses. `chapter`/`block` rows are
    // headers (no leaf code). When classKind is missing (e.g. ValueSet shape),
    // we keep the row — ValueSets typically already contain only categories.
    .filter(r => !r.classKind || r.classKind === 'category')
    .map(r => ({
      code: r.Code,
      display: r.Display,
      normCode: normalizeText(r.Code),
      normDisplay: normalizeText(r.Display),
      // Pass-through of BfArM CodeSystem properties (undefined when loaded
      // from the legacy ValueSet shape — code paths must tolerate that).
      usage: r.usage || '',            // 'dagger' | 'aster' | 'optional' | ''
      para301: r.Para301 || '',        // 'P' | 'V' | 'O' | 'Z' | ''
      para295: r.Para295 || '',        // 'P' | 'V' | 'O' | 'Z' | ''
      classKind: r.classKind || '',    // 'category' (filtered above) | ''
      parent: r.parent || '',          // chapter/block parent (for hierarchy)
    }));
}

function scoreRow(row, qNorm, qTokens) {
  let score = 0;
  if (/^[a-z][0-9]{2}(\.[0-9a-z])?/.test(qNorm)) {
    if (row.normCode === qNorm) score += 100;
    else if (row.normCode.startsWith(qNorm)) score += 60;
  }
  if (qNorm && row.normDisplay.includes(qNorm)) score += 12;

  // Establish whether ANY alpha token (≥4 chars) in the query also lands in
  // this row's display. Used as a gate so that bare single-digit tokens
  // ("4" from "Radikulopathie L4") don't dominate the score on rows that
  // happen to mention "Phase 4" / "4 Tage" / "Stadium 4" but have nothing
  // to do with the actual diagnosis. Generic linguistic anti-noise; not
  // tied to any example.
  let hasAlphaAnchor = false;
  for (const t of qTokens) {
    if (/^\d+$/.test(t)) continue;
    if (t.length < 4) continue;
    if (row.normDisplay.includes(t)) { hasAlphaAnchor = true; break; }
  }

  // Per-token contribution: numeric tokens (1, 2, 3) are *highly* discriminative
  // for typing/grading codes; weight them much higher than alpha tokens.
  for (const t of qTokens) {
    const isNum = /^\d+$/.test(t);
    if (isNum) {
      // require word-boundary match for digits so "2" doesn't match "20"/"22"
      const re = new RegExp(`(^|[^0-9])${t}([^0-9]|$)`);
      if (re.test(row.normDisplay)) {
        // Single-digit tokens only score when a non-numeric anchor token
        // also matches — keeps "Stadium 3", "Typ 2", "Grad I" boosts but
        // suppresses spurious matches from spine-level/joint refs (L4, T2,
        // C5) and similar fragments.
        if (t.length === 1 && !hasAlphaAnchor) continue;
        score += 10;
      }
    } else if (row.normDisplay.includes(t)) {
      score += 4;
    } else if (t.length >= 10) {
      // Long compound noun fallback: German agglutinative compounds
      // ("Bandscheibenvorfall" vs "Bandscheibenschäden") often share only
      // their head noun. If the first 9 chars of the query token appear at
      // a word boundary in the display, count it at half weight. Generic
      // morphological retrieval move — no domain rules.
      const prefix = t.slice(0, 9);
      const re = new RegExp(`(^|[^a-z])${prefix}[a-z]*`);
      if (re.test(row.normDisplay)) score += 2;
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
  // Precedence: explicit CodeSystem URL > legacy ValueSet URL > default
  // CodeSystem. The legacy env-var name is preserved for backwards compat
  // with deployments that pinned a ValueSet URL.
  const url =
    getEnv('ICD10GM_CODESYSTEM_URL') ||
    getEnv('ICD10GM_VALUESET_URL') ||
    DEFAULT_URL;
  // BfArM is a public endpoint and can be slow; cap network at 60s.
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`BfArM fetch HTTP ${res.status}`);
  const data = await res.json();
  // Accepted shapes:
  //   - BfArM rendering_data CodeSystem: { rows: [{Code, Display, usage,
  //     Para301, Para295, classKind, parent, ...}, ...] }
  //   - BfArM rendering_data ValueSet:   { rows: [{Code, Display}, ...] }
  //   - FHIR ValueSet expansion:         { expansion: { contains: [{code, display}, ...] } }
  //   - FHIR ValueSet compose:           { compose: { include: [{ concept: [{code, display}, ...] }] } }
  const rawRows =
    (Array.isArray(data?.rows) && data.rows) ||
    data?.expansion?.contains ||
    data?.compose?.include?.[0]?.concept ||
    [];
  const mapped = rawRows.map(r => ({
    Code: r.Code || r.code,
    Display: r.Display || r.display,
    // Pass through BfArM properties if present (no-op for ValueSet shapes).
    usage: r.usage,
    Para301: r.Para301,
    Para295: r.Para295,
    classKind: r.classKind,
    parent: r.parent,
  }));
  const rows = buildRows(mapped);
  // Detect whether properties were actually present in the upstream payload
  // — used so callers can decide whether to inject the BfArM property legend.
  const hasProperties = rows.some(r => r.usage || r.para301);
  return {
    rows,
    meta: {
      system: 'icd10gm',
      url,
      version: data?.version || '2026',
      title: data?.title || 'ICD-10-GM (BfArM)',
      date: data?.date || null,
      publisher: 'BfArM',
      hasProperties,
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
      const mapped = (fallback.rows || []).map(r => ({
        Code: r.Code || r.code,
        Display: r.Display || r.display,
        usage: r.usage,
        Para301: r.Para301,
        Para295: r.Para295,
        classKind: r.classKind,
        parent: r.parent,
      }));
      const rows = buildRows(mapped);
      cached = {
        index: rows,
        meta: {
          system: 'icd10gm',
          url: 'bundled-fallback',
          version: fallback.version || 'fallback',
          title: 'ICD-10-GM (bundled fallback)',
          date: null,
          publisher: 'BfArM',
          hasProperties: rows.some(r => r.usage || r.para301),
        },
        at: now,
      };
      return cached;
    } catch (_) {
      throw e;
    }
  }
}

// Map BfArM-internal property values to short, terse markers used in the
// allowedList that ships to the LLM. Returns null when no marker applies
// (no Properties available, or a "neutral" Para301=P primary-allowed plain
// category — to keep the list compact).
function markersFor(row) {
  if (!row) return null;
  const m = [];
  // Kreuz-Stern usage (Aster MUST never stand alone — see rulebook R2).
  if (row.usage === 'dagger') m.push('†');
  else if (row.usage === 'aster') m.push('*');
  else if (row.usage === 'optional') m.push('opt');
  // §301 SGB V Hauptdiagnose-Befugnis. Only render abnormal values; "P"
  // (primary allowed) is the default and would be noise.
  if (row.para301 === 'V') m.push('HD✗');
  else if (row.para301 === 'O') m.push('HDopt');
  else if (row.para301 === 'Z') m.push('Zusatz');
  return m.length ? m.join(' ') : null;
}

async function search(query, limit = 10) {
  const { index, meta } = await getIndex();
  const qNorm = normalizeText(query || '');
  const qTokens = tokenize(qNorm);
  if (!qNorm) return { meta, results: [] };
  const scored = [];
  for (const row of index) {
    const s = scoreRow(row, qNorm, qTokens);
    if (s > 0) scored.push({
      code: row.code,
      display: row.display,
      score: +s.toFixed(3),
      usage: row.usage || undefined,
      para301: row.para301 || undefined,
      markers: markersFor(row) || undefined,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { meta, results: scored.slice(0, limit) };
}

async function getCode(code) {
  const { index, meta } = await getIndex();
  const norm = normalizeText(code);
  const hit = index.find(r => r.normCode === norm);
  if (!hit) return { meta, result: null };
  return {
    meta,
    result: {
      code: hit.code,
      display: hit.display,
      usage: hit.usage || undefined,
      para301: hit.para301 || undefined,
      para295: hit.para295 || undefined,
      classKind: hit.classKind || undefined,
      parent: hit.parent || undefined,
      markers: markersFor(hit) || undefined,
    },
  };
}

async function listAll(limit = 0) {
  const { index, meta } = await getIndex();
  return {
    meta,
    count: index.length,
    results: limit > 0 ? index.slice(0, limit).map(r => ({
      code: r.code,
      display: r.display,
      usage: r.usage || undefined,
      para301: r.para301 || undefined,
      markers: markersFor(r) || undefined,
    })) : null,
  };
}

// ---------------------------------------------------------------------------
// Hardrule book — the verbatim/officially-paraphrased coding rules that the
// classifier prompt should embed. Returned as a single string; the caller
// decides whether to inject it (e.g. only when meta.hasProperties is true).
//
// All wording traces to: BfArM ICD-10-GM Klassifikationsregel
// (Property-Definitionen für usage und Para301/Para295) und die offiziellen
// Definitionen der Deutschen Kodierrichtlinien 2026 (Allgemeine
// Kodierrichtlinien D-Sektion; InEK, herausgegeben mit den jährlichen DRG-
// Vereinbarungen). KEINE agentengenerierten Regeln, KEINE Beispiel-getriebenen
// Verallgemeinerungen.
// ---------------------------------------------------------------------------
function getRulebook() {
  return [
    'HARTE KODIERREGELN (verbindlich, Quelle: BfArM ICD-10-GM Klassifikationsregel + InEK Deutsche Kodierrichtlinien — Allgemeine Kodierrichtlinien D-Sektion):',
    '',
    '(R1) Markierungen der erlaubten Codes (BfArM-Properties):',
    '     †      = Kreuz-Code (usage="dagger"): bezeichnet die Ätiologie/Grunderkrankung.',
    '     *      = Stern-Code (usage="aster"): bezeichnet die Manifestation an einem bestimmten Organ.',
    '     opt    = optionaler Zusatzschlüssel (usage="optional").',
    '     HD✗    = §301 SGB V "V" — als Hauptdiagnose NICHT zulässig. Diese Codes dürfen NICHT mit role="primary" zugewiesen werden.',
    '     HDopt  = §301 SGB V "O" — als Hauptdiagnose nur in besonderen Fällen.',
    '     Zusatz = §301 SGB V "Z" — Zusatzcode; NICHT alleine kodierbar, nur in Verbindung mit einem anderen Code.',
    '     (Codes ohne Markierung sind als Hauptdiagnose zulässig.)',
    '',
    '(R2) Kreuz-Stern-System (BfArM-Klassifikationsregel):',
    '     Ein Stern-Code (*) darf NIE allein verschlüsselt werden, sondern stets nur in Verbindung mit dem zugehörigen Kreuz-Code (†).',
    '     Wenn du einen Stern-Code (*) wählst, MUSS aus der erlaubten Liste auch der thematisch zugehörige Kreuz-Code (†) verschlüsselt werden.',
    '     Wenn ein Kreuz-Code (†) gewählt wird und die erlaubte Liste einen thematisch passenden Stern-Code (*) enthält, sollen beide kodiert werden.',
    '',
    '(R3) Hauptdiagnose (DKR D002):',
    '     "Die Diagnose, die nach Analyse als diejenige festgestellt wurde, die hauptsächlich für die Veranlassung des stationären Krankenhausaufenthaltes des Patienten verantwortlich ist."',
    '     Maximal EIN Code pro Seite darf role="primary" tragen. Im Dokument darf insgesamt nur EINE Diagnose die Hauptdiagnose sein.',
    '',
    '(R4) Nebendiagnosen (DKR D003):',
    '     Eine Nebendiagnose ist nur zu kodieren, wenn sie therapeutische, diagnostische oder pflegerische/überwachende Maßnahmen erforderlich gemacht hat. Ohne dokumentierten Mehraufwand keine Nebendiagnose.',
    '',
    '(R5) Liste verbindlich:',
    '     Verschlüssele AUSSCHLIESSLICH Codes aus der unten stehenden ERLAUBTE-CODES-Liste. Wenn ein thematisch passender Code dort nicht enthalten ist, lasse die Diagnose weg — keine Codes erfinden, keine Codes aus dem Gedächtnis ergänzen.',
  ].join('\n');
}

module.exports = { search, getCode, listAll, getRulebook };
