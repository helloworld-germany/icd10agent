'use strict';

const { getEnv } = require('./http');
const { getProvider } = require('./icdCodeSystem');
const llm = require('./llm');

// ---------------------------------------------------------------------------
// LLM plumbing — provider-agnostic (Azure OpenAI by default, Mistral via
// Azure AI Foundry when LLM_PROVIDER=mistral). All config-building and HTTP
// dispatch lives in ./llm; this file is purely about prompts and pipelines.
// ---------------------------------------------------------------------------

function llmConfig(role = 'reasoning') {
  return llm.getConfig(role);
}

async function callChat(cfg, messages, temperature = 0.0) {
  return llm.callChat(cfg, messages, temperature);
}

// ---------------------------------------------------------------------------
// Candidate gathering — two passes:
//   1. LLM term-extraction: ask GPT to list normalized diagnosis terms (with
//      hints for typing/grading where derivable: "Diabetes mellitus Typ 2",
//      "Adipositas Grad I", "Hypertonie Grad 2", "CKD Stadium 3a", ...).
//      For ICD-10-GM this is critical because the BfArM display strings have
//      no synonym layer.
//   2. Sentence-chunk fallback: still searches sentence-shaped chunks so
//      anything the term extractor missed is still considered.
// The union of both feeds the LLM-classification step's "allowed list".
// ---------------------------------------------------------------------------

function chunkText(text, maxLen = 240) {
  const out = [];
  const parts = text
    .split(/(?<=[\.\!\?\:])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part.length <= maxLen) { out.push(part); continue; }
    for (let i = 0; i < part.length; i += maxLen) out.push(part.slice(i, i + maxLen));
  }
  return out.length ? out : [text.slice(0, maxLen)];
}

async function extractTerms(cfg, pages, systemKey) {
  const sysName = systemKey === 'icd11' ? 'ICD-11' : 'ICD-10-GM';
  const blocks = pages.map(p => `--- Seite ${p.page} ---\n${p.text}`).join('\n\n');
  const icd10gmHint = systemKey === 'icd10gm' ? [
    '',
    'WICHTIG für ICD-10-GM (BfArM): Die offiziellen Display-Strings der BfArM-Klassifikation verwenden häufig FACHTERMINOLOGIE,',
    'die vom alltäglichen Klinikjargon des Arztbriefs systematisch abweicht. Beispiele für typische Diktionswechsel:',
    '- klinischer Jargon ↔ formale lateinisch/griechische Nomenklatur (z.B. "Bluthochdruck"/"arterielle Hypertonie" ↔ "essentielle (primäre) Hypertonie")',
    '- Substanzbezogenes ("Nikotin", "Alkohol") ↔ Stoffklassen-Begriffe der ICD ("Tabak", "Alkohol-bedingte Störung")',
    '- "Z.n. <Eingriff>" ↔ "Vorhandensein von <Implantat>" / "Zustand nach <formaler OP-Name>"',
    '- englische/abgekürzte Befunde (STEMI, PCI, CKD, COPD, NSTEMI) ↔ deutsche Vollform der ICD',
    '- Eponyme/Markennamen ↔ deskriptive Diagnose',
    '',
    'Gib daher pro Diagnose **bis zu 3 alternative Suchphrasen** (Term + Synonyme) aus, die du auf Basis dieser Übersetzungsmuster für die BfArM-Diktion generierst.',
    'Decke aktiv beide Welten ab: einmal den im Brief verwendeten Begriff, einmal den vermuteten formalen ICD-Begriff,',
    'optional eine dritte verwandte Formulierung (z.B. Synonym, lateinische Form, Implantats-/Folgezustands-Variante).',
    'Keine erfundenen Codes – nur Suchphrasen.',
  ].join('\n') : '';
  const sys = [
    `Du bist medizinischer Vorklassifikator (${sysName}).`,
    'Aufgabe: Lies das Dokument und extrahiere alle Diagnosen, Befunde, Komorbiditäten und Z.n.-Zustände als normalisierte, kurze deutsche Suchphrasen.',
    'Wichtig:',
    '- Wenn aus dem Text der Typ/Grad/das Stadium ableitbar ist, schreibe ihn EXPLIZIT in den Term (z.B. "Diabetes mellitus Typ 2 mit Nierenkomplikation", "Adipositas Grad I", "Chronische Niereninsuffizienz Stadium G3a", "Arterielle Hypertonie Grad 2").',
    '- Aus BMI ableitbar: BMI 30-34.9 = Grad I, 35-39.9 = Grad II, ≥40 = Grad III.',
    '- Z.n. Eingriffe (PCI/Stent, Bypass, OPs) ebenfalls extrahieren.',
    '- Keine Medikamentennamen, keine Laborwerte ohne Diagnose, keine Datumsangaben.',
    icd10gmHint,
    'Antwortformat: JSON {"terms":["<term1>","<term2>", ...]}. Es darf eine LANGE Liste (bis ~60 Einträge) sein, wenn du Synonyme mit ausgibst.',
  ].filter(Boolean).join('\n');
  try {
    const res = await callChat(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: blocks },
    ]);
    const terms = Array.isArray(res?.terms) ? res.terms.filter(t => typeof t === 'string' && t.trim()) : [];
    return terms;
  } catch (err) {
    console.warn(`[extractTerms] ${err.message}`);
    return [];
  }
}

// 3-char stem of an ICD code: "I25.10" → "I25", "E11.40" → "E11", "BA00" → "BA0".
// For ICD-10-GM the standard category is letter+2digits; for ICD-11 the first 3
// alphanumerics are the chapter/block stem. Either way, 3 chars is a sane bucket.
function stemOf(code) {
  return (code || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
}

async function gatherCandidates(cfgFast, provider, pages, systemKey, { perTerm = 12, perChunk = 8, perStem = 12, maxTotal = 120 } = {}) {
  const seen = new Map();
  const addResults = (results) => {
    for (const r of results) {
      if (!r.code) continue;
      if (!seen.has(r.code)) seen.set(r.code, r);
      if (seen.size >= maxTotal) return true;
    }
    return false;
  };

  // Pass 1 — LLM-extracted terms (uses the fast/cheap deployment)
  const terms = await extractTerms(cfgFast, pages, systemKey);
  for (const t of terms) {
    if (seen.size >= maxTotal) break;
    try {
      const { results } = await provider.search(t, perTerm);
      if (addResults(results)) break;
    } catch (err) { console.warn(`[gatherCandidates/term "${t}"] ${err.message}`); }
  }

  // Pass 2 — sentence-chunk fallback
  for (const p of pages) {
    if (seen.size >= maxTotal) break;
    const chunks = chunkText(p.text);
    chunks.unshift(p.text.split(/\s+/).slice(0, 40).join(' '));
    for (const q of chunks) {
      if (seen.size >= maxTotal) break;
      try {
        const { results } = await provider.search(q, perChunk);
        addResults(results);
      } catch (err) { console.warn(`[gatherCandidates/chunk] ${err.message}`); }
    }
  }

  // Pass 3 — sibling expansion: for every code already retrieved, pull in all
  // siblings sharing the 3-char stem. This compensates for the systematic miss
  // mode where the right *category* is found but the wrong *suffix* (e.g.
  // I63.5 vs I63.8, K80.00 vs K80.20). Pure retrieval move, no semantic bias.
  const stems = new Set();
  for (const c of seen.values()) {
    const s = stemOf(c.code);
    if (s && s.length === 3) stems.add(s);
  }
  for (const stem of stems) {
    if (seen.size >= maxTotal) break;
    try {
      const { results } = await provider.search(stem, perStem);
      addResults(results);
    } catch (err) { console.warn(`[gatherCandidates/stem "${stem}"] ${err.message}`); }
  }

  return { candidates: Array.from(seen.values()), terms };
}

function buildAllowedList(candidates) {
  return candidates.map(c => `${c.code} — ${c.display}`).join('\n');
}

// ---------------------------------------------------------------------------
// Prompts — multi-code per page
// ---------------------------------------------------------------------------

function systemPrompt(systemKey, allowedList) {
  const sysName = systemKey === 'icd11' ? 'ICD-11 (WHO MMS)' : 'ICD-10-GM (BfArM)';
  return [
    `Du bist medizinischer Klassifikator für ${sysName}.`,
    'Aufgabe: Extrahiere ALLE relevanten Diagnosen/Befunde aus dem Dokument.',
    'Es können MEHRERE Codes pro Seite vorkommen (Haupt- und Nebendiagnosen, Komorbiditäten, dokumentierte Befunde).',
    'Verwende AUSSCHLIESSLICH Codes aus der unten stehenden erlaubten Liste.',
    'Antwortformat: JSON',
    '{"classifications":[{"page":<int>,"codes":[',
    '  {"code":"<code>","display":"<display>","confidence":<0..1>,',
    '   "role":"primary|secondary|comorbidity|finding","evidence":"<kurzes Textzitat>",',
    '   "reasoning":"<kurz, de>"}',
    ']}]}',
    'Wenn eine Seite keine kodierbaren Inhalte hat, gib für sie `"codes": []` zurück.',
    'Setze maximal EINEN Code pro Seite auf role="primary". Duplikate vermeiden.',
    '',
    'ERLAUBTE CODES:',
    allowedList,
  ].join('\n');
}

function userPromptContextAware(pages) {
  const blocks = pages.map(p => `--- Seite ${p.page} ---\n${p.text}`).join('\n\n');
  return [
    'Hier ist ein Dokument als Seiten-Sequenz. Berücksichtige Querverweise und "Fortsetzungs"-Hinweise. Extrahiere pro Seite alle einschlägigen Codes.',
    '',
    blocks,
  ].join('\n');
}

function userPromptIndependent(pages) {
  const blocks = pages.map(p => `--- Block ${p.page} ---\n${p.text}`).join('\n\n');
  return [
    'Klassifiziere JEDEN Block ISOLIERT (ignoriere Nachbarblöcke). Extrahiere alle einschlägigen Codes je Block.',
    '',
    blocks,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Merging — per (page, code) pair across the two GPT calls
// ---------------------------------------------------------------------------

function indexByPageCode(classifications) {
  const m = new Map();
  for (const entry of classifications || []) {
    const page = Number(entry.page) || 0;
    const codes = Array.isArray(entry.codes) ? entry.codes : [];
    if (!m.has(page)) m.set(page, new Map());
    const inner = m.get(page);
    for (const c of codes) {
      if (!c || !c.code) continue;
      const prev = inner.get(c.code);
      if (!prev || (Number(c.confidence) || 0) > (Number(prev.confidence) || 0)) inner.set(c.code, c);
    }
  }
  return m;
}

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

function mergePerPage(resA, resB) {
  const a = indexByPageCode(resA?.classifications);
  const b = indexByPageCode(resB?.classifications);
  const allPages = new Set([...a.keys(), ...b.keys()]);

  const out = [];
  for (const page of [...allPages].sort((x, y) => x - y)) {
    const aCodes = a.get(page) || new Map();
    const bCodes = b.get(page) || new Map();
    const allCodes = new Set([...aCodes.keys(), ...bCodes.keys()]);
    const codes = [];
    for (const code of allCodes) {
      const ac = aCodes.get(code);
      const bc = bCodes.get(code);
      if (ac && bc) {
        const conf = Math.min(1, ((Number(ac.confidence) || 0.5) + (Number(bc.confidence) || 0.5)) / 2 + 0.1);
        codes.push({
          code,
          display: ac.display || bc.display,
          confidence: round3(conf),
          role: ac.role || bc.role || 'secondary',
          evidence: ac.evidence || bc.evidence,
          reasoning: ac.reasoning || bc.reasoning,
          verified: true,
          verificationMethod: 'dual-call-agree',
        });
      } else {
        const only = ac || bc;
        codes.push({
          code,
          display: only.display,
          confidence: round3((Number(only.confidence) || 0.4) * 0.75), // demote unverified
          role: only.role || 'secondary',
          evidence: only.evidence,
          reasoning: only.reasoning,
          verified: false,
          verificationMethod: ac ? 'context-aware-only' : 'independent-only',
        });
      }
    }
    codes.sort((x, y) => {
      const rx = x.role === 'primary' ? 0 : 1;
      const ry = y.role === 'primary' ? 0 : 1;
      if (rx !== ry) return rx - ry;
      return (y.confidence || 0) - (x.confidence || 0);
    });
    out.push({ page, codes });
  }
  return out;
}

function aggregateDocument(perPage) {
  const m = new Map();
  for (const entry of perPage) {
    for (const c of entry.codes) {
      const cur = m.get(c.code) || {
        code: c.code,
        display: c.display,
        bestConfidence: 0,
        pages: [],
        roles: new Set(),
        verifiedAnywhere: false,
      };
      cur.bestConfidence = Math.max(cur.bestConfidence, Number(c.confidence) || 0);
      cur.pages.push(entry.page);
      if (c.role) cur.roles.add(c.role);
      if (c.verified) cur.verifiedAnywhere = true;
      m.set(c.code, cur);
    }
  }
  const arr = [...m.values()].map(x => ({
    code: x.code,
    display: x.display,
    confidence: round3(Math.min(1, x.bestConfidence + Math.min(0.15, 0.05 * (x.pages.length - 1)))),
    pages: x.pages.sort((a, b) => a - b),
    role: x.roles.has('primary') ? 'primary' : (x.roles.values().next().value || 'secondary'),
    verified: x.verifiedAnywhere,
  }));
  arr.sort((x, y) => {
    const rx = x.role === 'primary' ? 0 : 1;
    const ry = y.role === 'primary' ? 0 : 1;
    if (rx !== ry) return rx - ry;
    return (y.confidence || 0) - (x.confidence || 0);
  });
  return arr;
}

// ---------------------------------------------------------------------------
// Verification pass — third LLM call.
// Given the original document and a subset of candidate (page, code) pairs
// from the merged classification, ask the model to keep only those that are
// *explicitly or unambiguously implicitly* supported by the source text and
// to cite the evidence span. No examples, no per-code hints.
//
// Two modes:
//   - mode = 'strict' (original): drop everything the model can't cite.
//   - mode = 'conservative' (Option E): keep everything by default, only drop
//     codes the model explicitly flags as CONTRADICTED by the text.
//
// Optimisation: callers may pass `onlyUnverified=true` to skip codes that
// already carry `verified: true` from the dual-call-agreement step.
// ---------------------------------------------------------------------------

async function verifyClassifications(cfg, pages, perPage, systemKey, { onlyUnverified = false, mode = 'strict' } = {}) {
  // Partition perPage into "to verify" and "passthrough" sets when requested.
  const toVerify = [];
  const passthrough = new Map(); // page -> Map(code -> codeObj)
  if (onlyUnverified) {
    for (const entry of perPage) {
      const verifyCodes = [];
      const passCodes = new Map();
      for (const c of entry.codes) {
        if (c.verified) passCodes.set(c.code, c);
        else verifyCodes.push(c);
      }
      if (verifyCodes.length) toVerify.push({ page: entry.page, codes: verifyCodes });
      passthrough.set(entry.page, passCodes);
    }
    if (toVerify.length === 0) {
      // Nothing to verify — short-circuit: return input unchanged, no LLM call.
      return perPage;
    }
  }
  const verifyInput = onlyUnverified ? toVerify : perPage;

  const sysName = systemKey === 'icd11' ? 'ICD-11 (WHO MMS)' : 'ICD-10-GM (BfArM)';
  const docBlocks = pages.map(p => `--- Seite ${p.page} ---\n${p.text}`).join('\n\n');
  const codeBlocks = verifyInput.map(entry => {
    const lines = entry.codes.map(c => `  - ${c.code} — ${c.display || ''}`).join('\n') || '  (keine)';
    return `Seite ${entry.page}:\n${lines}`;
  }).join('\n\n');

  const sys = mode === 'conservative' ? [
    `Du bist medizinischer Auditor für ${sysName}.`,
    'Aufgabe: Prüfe jede vorgeschlagene (Seite, Code)-Zuordnung.',
    'GRUNDREGEL: Im Zweifel BEHALTEN. Droppe einen Code NUR, wenn der Text der Diagnose AKTIV WIDERSPRICHT (z.B. "keine Hinweise auf X", "X ausgeschlossen", "differentialdiagnostisch erwogen, aber nicht bestätigt").',
    'Codes, die thematisch passen und nicht widersprochen werden, gelten als unterstützt — auch ohne wörtliches Zitat.',
    'Antwortformat: JSON {"verified":[{"page":<int>,"code":"<code>","evidence":"<kurze Begründung oder Zitat>","confidence":<0..1>}], "dropped":[{"page":<int>,"code":"<code>","reason":"<aktiver Widerspruch>"}]}',
  ].join('\n') : [
    `Du bist medizinischer Auditor für ${sysName}.`,
    'Aufgabe: Prüfe für jede vorgeschlagene (Seite, Code)-Zuordnung, ob sie durch den Originaltext gedeckt ist.',
    'Eine Zuordnung ist gedeckt, wenn die Diagnose/der Befund auf der Seite explizit genannt oder zwingend implizit ableitbar ist (z.B. aus dokumentiertem BMI, Stadium, Histologie).',
    'Sie ist NICHT gedeckt bei Verdacht ohne Bestätigung, bei Differentialdiagnosen ohne Aussage, oder wenn der Code thematisch passt aber im Text nicht steht.',
    'Antwortformat: JSON {"verified":[{"page":<int>,"code":"<code>","evidence":"<wortgetreues Zitat aus dem Text>","confidence":<0..1>}]}',
    'Gib NUR die gedeckten Zuordnungen zurück. Keine Erfindungen, keine neuen Codes.',
  ].join('\n');

  const user = [
    'ORIGINALTEXT:',
    docBlocks,
    '',
    'VORGESCHLAGENE ZUORDNUNGEN:',
    codeBlocks,
  ].join('\n');

  let res;
  try {
    res = await callChat(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);
  } catch (err) {
    console.warn(`[verifier] ${err.message}`);
    return null; // verifier failure → fall back to unverified pipeline
  }
  const verified = Array.isArray(res?.verified) ? res.verified : [];

  // Build allow-set keyed by `${page}::${code}` for fast lookup, and a confidence map.
  const allow = new Map();
  for (const v of verified) {
    if (!v || !v.code) continue;
    const page = Number(v.page) || 0;
    const key = `${page}::${v.code}`;
    const conf = Math.max(0, Math.min(1, Number(v.confidence) || 0.7));
    const prev = allow.get(key);
    if (!prev || conf > prev.confidence) allow.set(key, { confidence: conf, evidence: v.evidence || '' });
  }

  const out = [];
  // When in onlyUnverified mode we need to emit ALL pages (incl. those that
  // had nothing to verify) and merge passthrough + verifier-survivors per page.
  const allPages = onlyUnverified
    ? Array.from(new Set([...perPage.map(e => e.page)]))
    : perPage.map(e => e.page);

  for (const page of allPages) {
    const verifyEntry = verifyInput.find(e => e.page === page);
    const codes = [];

    // 1) Codes that went through the verifier on this page
    if (verifyEntry) {
      for (const c of verifyEntry.codes) {
        const hit = allow.get(`${page}::${c.code}`);
        if (!hit) continue;
        codes.push({
          ...c,
          confidence: round3(Math.min(1, ((Number(c.confidence) || 0.5) + hit.confidence) / 2 + 0.05)),
          evidence: hit.evidence || c.evidence,
          verified: true,
          verificationMethod: c.verificationMethod === 'dual-call-agree' ? 'dual-agree+verifier' : 'verifier-confirmed',
        });
      }
    }

    // 2) Passthrough codes (dual-agree, skipped the verifier) — keep as-is
    if (onlyUnverified) {
      const pass = passthrough.get(page);
      if (pass) {
        for (const c of pass.values()) codes.push(c);
      }
    }

    out.push({ page, codes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function classifyPages(pages, { system = 'icd10gm', languageHint = 'de' } = {}) {
  const cfgReasoning = llmConfig('reasoning');
  const cfgFast = llmConfig('fast');
  if (!cfgReasoning.baseUrl || !cfgReasoning.deployment) {
    const which = cfgReasoning.provider === 'mistral' ? 'Mistral (AZURE_MISTRAL_*)' : 'Azure OpenAI (AZURE_OPENAI_*)';
    throw new Error(`LLM provider not configured: ${which} — endpoint and deployment are required`);
  }
  const provider = getProvider(system);
  const { candidates, terms } = await gatherCandidates(cfgFast, provider, pages, provider.key);
  const meta = (await provider.search('', 1)).meta;

  if (candidates.length === 0) {
    return {
      classifications: pages.map(p => ({ page: p.page, codes: [] })),
      documentCodes: [],
      codeSystem: meta,
      candidates: [],
      extractedTerms: terms,
    };
  }

  const sys = systemPrompt(provider.key, buildAllowedList(candidates));

  const [resA, resB] = await Promise.all([
    callChat(cfgReasoning, [
      { role: 'system', content: sys },
      { role: 'user', content: userPromptContextAware(pages) },
    ]),
    callChat(cfgReasoning, [
      { role: 'system', content: sys },
      { role: 'user', content: userPromptIndependent(pages) },
    ]),
  ]);

  let classifications = mergePerPage(resA, resB);
  // Filter out hallucinated codes that aren't in the candidate list.
  const allowedSet = new Set(candidates.map(c => c.code));
  for (const entry of classifications) {
    entry.codes = entry.codes.filter(c => allowedSet.has(c.code));
  }

  // Verification pass — togglable. Default 'off' after eval showed the strict
  // verifier was filtering out too many true positives (Primary-Hit dropped
  // from 72 to 60/127 vs the dual-call-only baseline). Set
  // CLASSIFY_VERIFIER_MODE=strict to re-enable the original filter, or
  // CLASSIFY_VERIFIER_MODE=conservative for a 'only drop if actively
  // contradicted by text' variant.
  const verifierMode = (getEnv('CLASSIFY_VERIFIER_MODE', 'off') || 'off').toLowerCase();
  if (verifierMode === 'strict' || verifierMode === 'conservative') {
    const verified = await verifyClassifications(cfgFast, pages, classifications, provider.key, { mode: verifierMode });
    if (verified) classifications = verified;
  }

  const documentCodes = aggregateDocument(classifications);

  return {
    classifications,
    documentCodes,
    codeSystem: meta,
    candidates,
    extractedTerms: terms,
    models: {
      provider: cfgReasoning.provider,
      reasoning: cfgReasoning.deployment,
      fast: cfgFast.deployment,
      verifier: verifierMode,
      reasoningEffort: cfgReasoning.reasoningEffort || null,
    },
  };
}

module.exports = { classifyPages };
