'use strict';

const { classifyPages } = require('../shared/classifyGpt');
const { extractFromFile } = require('../shared/extract');
const { json, badRequest, serverError, normalizeSystem, getEnv } = require('../shared/http');

function isJsonContentType(ct) {
  return /application\/json/i.test(ct || '');
}

function isBinaryContentType(ct) {
  if (!ct) return false;
  return /^(image\/|application\/pdf|application\/octet-stream)/i.test(ct);
}

// Azure Functions v3-style HTTP trigger on Node 22/Linux delivers binary
// payloads in three different fields:
//   req.body       — UTF-8 decoded string (LOSSY for non-text bytes!)
//   req.bufferBody — raw Buffer (preferred for binary uploads)
//   req.rawBody    — same string as req.body
// We must read req.bufferBody whenever we need true binary fidelity.
function bodyAsBuffer(req) {
  if (!req) return null;
  if (Buffer.isBuffer(req.bufferBody)) return req.bufferBody;
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  return null;
}

// For JSON bodies the string form is fine, but we still prefer bufferBody so
// strict UTF-8 parsing matches the original bytes exactly.
function parseJsonBody(req) {
  if (req && typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body) && !(req.body instanceof Uint8Array)) {
    return req.body;
  }
  const buf = bodyAsBuffer(req);
  if (!buf || !buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('Invalid JSON body: ' + e.message); }
}

async function pagesFromBody(req) {
  const ct = req.headers['content-type'] || '';

  if (isJsonContentType(ct)) {
    const body = parseJsonBody(req);
    if (body && typeof body === 'object') {
      if (typeof body.text === 'string' && body.text.trim()) {
        return [{ page: 1, text: body.text.trim() }];
      }
      if (Array.isArray(body.moments)) {
        return body.moments
          .map((m, i) => ({ page: m.page || i + 1, text: (m.text || '').toString().trim() }))
          .filter(p => p.text);
      }
      if (typeof body.file === 'string' && body.file.length > 0) {
        const fileCt = body.fileContentType || 'application/octet-stream';
        const buf2 = Buffer.from(body.file, 'base64');
        if (!buf2.length) throw new Error('Decoded base64 file is empty');
        return await extractFromFile(buf2, fileCt);
      }
    }
  }

  // Binary upload directly (image/pdf). Must use req.bufferBody for fidelity:
  // req.body is a UTF-8 string with U+FFFD replacements that corrupt the data.
  if (isBinaryContentType(ct)) {
    const buf = bodyAsBuffer(req);
    if (!buf || buf.length === 0) throw new Error('Empty binary body');
    return await extractFromFile(buf, ct);
  }

  throw new Error('Provide one of: JSON {text} | JSON {moments[]} | JSON {file, fileContentType} | raw image/pdf body');
}

module.exports = async function (context, req) {
  try {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let parsedBody = null;
    if (/application\/json/.test(ct)) {
      try { parsedBody = parseJsonBody(req); } catch { parsedBody = null; }
    }
    const system = normalizeSystem(
      (req.query && req.query.system) || (parsedBody && parsedBody.system),
      getEnv('DEFAULT_SYSTEM', 'icd10gm'),
    );
    const languageHint = ((req.query && req.query.languageHint) || (parsedBody && parsedBody.languageHint) || 'de').toString();

    const pages = await pagesFromBody(req);
    if (!pages.length) {
      // After a successful OCR with 0 lines this is almost always a scanned
      // PDF where the embedded images are too low-resolution / handwriting /
      // a password-protected or encrypted document. Make the user-facing
      // message actionable instead of cryptic.
      return badRequest(
        context,
        'No textual content found. The document was processed but no text could '
        + 'be extracted. Likely causes: very low-resolution scan, handwritten text, '
        + 'password-protected PDF, or empty pages. Try a higher-quality scan or '
        + 'paste the text directly via the `{ text: "..." }` JSON payload.',
      );
    }

    const result = await classifyPages(pages, { system, languageHint });

    json(context, 200, {
      system,
      pageCount: pages.length,
      ...result,
    });
  } catch (err) {
    serverError(context, err);
  }
};
