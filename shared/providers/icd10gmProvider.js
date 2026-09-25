'use strict';

const { getEnv } = require('../http');
const searchAliases = require('../../config/icd10gm-search-aliases.json');

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

function normalizeCode(value) {
  return (value || '').toString().trim().toLowerCase().replace(/[^a-z0-9.\-]/g, '');
}

function tokenize(norm) {
  const stop = new Set([
    'und', 'oder', 'mit', 'ohne', 'der', 'die', 'das', 'des', 'dem', 'den',
    'im', 'in', 'am', 'an', 'auf', 'bei', 'fur', 'von', 'zu', 'zum', 'zur',
    'eine', 'einer', 'eines', 'ein', 'nicht', 'naher', 'bezeichnet',
  ]);
  return norm.split(' ')
    .map(t => t.trim())
    .filter(t => t.length > 0 && !stop.has(t))
    // keep all numeric tokens (Typ 1/2, Grad 1/2/3, Stadium 3 ...)
    // and alpha tokens of length >= 3
    .filter(t => /^\d+$/.test(t) || t.length >= 3);
}

function collectSearchTerms(row) {
  const values = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') {
      add(value.value);
      add(value.display);
      add(value.term);
    }
  };

  add(row.Designation);
  add(row.designation);
  add(row.Synonyms);
  add(row.synonyms);
  add(row.Terms);
  add(row.terms);
  return values;
}

const aliasGroups = (searchAliases.equivalents || [])
  .map(group => group.map(normalizeText).filter(Boolean))
  .filter(group => group.length > 1);

const tokenAliases = new Map();
for (const group of aliasGroups) {
  const singleTokens = group.filter(term => !term.includes(' '));
  for (const term of singleTokens) {
    tokenAliases.set(term, new Set(singleTokens.filter(candidate => candidate !== term)));
  }
}

function queryVariants(qNorm) {
  const variants = new Set([qNorm]);
  for (const group of aliasGroups) {
    for (const source of group) {
      const pattern = new RegExp(`(^|\\s)${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g');
      if (!pattern.test(qNorm)) continue;
      for (const target of group) {
        if (target === source) continue;
        variants.add(qNorm.replace(pattern, (_, prefix) => `${prefix}${target}`));
      }
    }
  }
  return [...variants];
}

function buildRows(rawRows) {
  return rawRows
    .filter(r => r && typeof r.Code === 'string' && typeof r.Display === 'string')
    // CodeSystem categories with children are grouping nodes, not terminal
    // diagnosis codes. ValueSet rows have no classKind/child and are already
    // terminal, so they remain supported for backwards compatibility.
    .filter(r => !r.classKind || (r.classKind === 'category' && !r.child && r.Para301 !== 'V'))
    .map(r => {
      const terms = collectSearchTerms(r);
      const normSearch = normalizeText([r.Display, ...terms].join(' '));
      return {
        code: r.Code,
        display: r.Display,
        normCode: normalizeCode(r.Code),
        normDisplay: normalizeText(r.Display),
        normSearch,
        searchTokens: new Set(tokenize(normSearch)),
        terms,
        // Pass-through of BfArM CodeSystem properties (undefined when loaded
        // from the legacy ValueSet shape — code paths must tolerate that).
        usage: r.usage || '',            // 'dagger' | 'aster' | 'optional' | ''
        para301: r.Para301 || '',        // 'P' | 'V' | 'O' | 'Z' | ''
        para295: r.Para295 || '',        // 'P' | 'V' | 'O' | 'Z' | ''
        classKind: r.classKind || '',    // 'category' (filtered above) | ''
        parent: r.parent || '',          // chapter/block parent (for hierarchy)
      };
    });
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

function fuzzyTokenMatch(queryToken, searchTokens) {
  if (queryToken.length < 6) return false;
  for (const candidate of searchTokens) {
    if (candidate.length < 6 || candidate[0] !== queryToken[0]) continue;
    if (Math.abs(candidate.length - queryToken.length) > 2) continue;
    const distance = editDistance(queryToken, candidate);
    if (1 - (distance / Math.max(queryToken.length, candidate.length)) >= 0.84) return true;
  }
  return false;
}

function matchToken(row, token) {
  if (row.searchTokens.has(token)) return 4;
  const aliases = tokenAliases.get(token);
  if (aliases && [...aliases].some(alias => row.searchTokens.has(alias))) return 3;
  if (fuzzyTokenMatch(token, row.searchTokens)) return 2;
  if (token.length >= 10) {
    const prefix = token.slice(0, 9);
    if ([...row.searchTokens].some(candidate => candidate.startsWith(prefix))) return 2;
  }
  return 0;
}

function scoreRow(row, qNorm, qCode, qTokens, qVariants) {
  let score = 0;
  let codeMatched = false;
  const isCodeQuery = /^[a-z][0-9]{2}(\.[0-9a-z]*)?$/.test(qCode);
  if (isCodeQuery) {
    if (row.normCode === qCode) {
      score += 100;
      codeMatched = true;
    } else if (row.normCode.startsWith(qCode)) {
      score += 60;
      codeMatched = true;
    }
    if (!codeMatched) return 0;
    return score + (Math.min(row.code.length, 8) * 0.01);
  }

  const phraseMatched = qVariants.some(variant => variant && row.normSearch.includes(variant));
  if (phraseMatched) score += 12;

  let matchedTokens = 0;
  let hasAlphaAnchor = false;
  for (const t of qTokens) {
    const isNum = /^\d+$/.test(t);
    if (isNum) {
      const re = new RegExp(`(^|[^0-9])${t}([^0-9]|$)`);
      if (re.test(row.normSearch)) {
        score += 10;
        matchedTokens++;
      }
      continue;
    }

    const tokenScore = matchToken(row, t);
    if (tokenScore > 0) {
      score += tokenScore;
      matchedTokens++;
      if (t.length >= 4) hasAlphaAnchor = true;
    }
  }

  if (!phraseMatched && matchedTokens === 0) return 0;
  if (!phraseMatched && qTokens.some(t => !/^\d+$/.test(t)) && !hasAlphaAnchor) return 0;

  // Reward broad query coverage. This ranks rows matching the complete
  // diagnosis phrase above rows sharing only a generic token.
  if (qTokens.length) score += (matchedTokens / qTokens.length) * 4;

  // Penalize unmatched key digits in display when query has them (helps Typ 1 vs Typ 2)
  for (const t of qTokens) {
    if (!/^\d+$/.test(t)) continue;
    const otherDigits = (row.normDisplay.match(/\b\d+\b/g) || []).filter(d => d !== t && Number(d) < 10);
    if (otherDigits.length) score -= 3;
  }

  // Stable tie-breaker only. It must never turn an unrelated row into a hit.
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
    child: r.child,
    parent: r.parent,
    Designation: r.Designation || r.designation,
    Synonyms: r.Synonyms || r.synonyms,
    Terms: r.Terms || r.terms,
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
        child: r.child,
        parent: r.parent,
        Designation: r.Designation || r.designation,
        Synonyms: r.Synonyms || r.synonyms,
        Terms: r.Terms || r.terms,
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
  // §301 SGB V coding permission. "P" is the normal primary-coding case.
  // O/Z duplicate usage metadata on current BfArM terminal codes, so only
  // add a marker when the corresponding usage marker is absent.
  if (row.para301 === 'V') m.push('nicht-kodierbar');
  else if (row.para301 === 'O' && row.usage !== 'aster') m.push('*');
  else if (row.para301 === 'Z' && row.usage !== 'optional') m.push('!');
  return m.length ? m.join(' ') : null;
}

async function search(query, limit = 10) {
  const { index, meta } = await getIndex();
  const qNorm = normalizeText(query || '');
  const qCode = normalizeCode(query || '');
  const qTokens = tokenize(qNorm);
  const qVariants = queryVariants(qNorm);
  if (!qNorm) return { meta, results: [] };
  const scored = [];
  for (const row of index) {
    const s = scoreRow(row, qNorm, qCode, qTokens, qVariants);
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
  const norm = normalizeCode(code);
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
    '     §301 "P" = zur Primärverschlüsselung zugelassen.',
    '     §301 "O" = nur als Sternschlüsselnummer zugelassen.',
    '     §301 "Z" = nur als Ausrufezeichenschlüsselnummer zugelassen.',
    '     §301 "V" = nicht zur Verschlüsselung zugelassen und wird aus der erlaubten Codeliste ausgeschlossen.',
    '',
    '(R2) Kreuz-Stern-System (BfArM-Klassifikationsregel):',
    '     Ein Stern-Code (*) darf NIE allein verschlüsselt werden, sondern stets nur in Verbindung mit dem zugehörigen Kreuz-Code (†).',
    '     Wenn du einen Stern-Code (*) wählst, MUSS aus der erlaubten Liste auch der thematisch zugehörige Kreuz-Code (†) verschlüsselt werden.',
    '     Wenn ein Kreuz-Code (†) gewählt wird und eine Manifestation im Dokument belegt ist, soll der thematisch passende Stern-Code (*) ergänzt werden.',
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
