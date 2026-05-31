'use strict';

const { getProvider } = require('../shared/icdCodeSystem');
const { json, badRequest, serverError, normalizeSystem, clampLimit, getEnv } = require('../shared/http');

module.exports = async function (context, req) {
  try {
    const q = (req.query.text || req.query.q || '').toString().trim();
    const system = normalizeSystem(req.query.system, getEnv('DEFAULT_SYSTEM', 'icd10gm'));
    const limit = clampLimit(req.query.limit, 10, 50);
    if (!q) return badRequest(context, 'Missing required query parameter "text" (or "q").');

    const provider = getProvider(system);
    const { meta, results } = await provider.search(q, limit);

    json(context, 200, {
      system,
      input: q,
      limit,
      count: results.length,
      results,
      codeSystem: meta,
    });
  } catch (err) {
    serverError(context, err);
  }
};
