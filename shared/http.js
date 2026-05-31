'use strict';

function getEnv(name, fallback = '') {
  const v = process.env[name];
  return (v && String(v).trim()) ? String(v).trim() : fallback;
}

function json(context, status, body) {
  context.res = {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function html(context, status, htmlBody) {
  context.res = {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: htmlBody,
  };
}

function badRequest(context, message, extra) {
  json(context, 400, { error: 'bad_request', message, ...(extra || {}) });
}

function serverError(context, err, extra) {
  const msg = (err && err.message) ? err.message : String(err);
  if (context && context.log) context.log.error('serverError:', msg);
  json(context, 500, { error: 'server_error', message: msg, ...(extra || {}) });
}

function normalizeSystem(value, fallback = 'icd10gm') {
  const v = (value || '').toString().trim().toLowerCase();
  if (v === 'icd11' || v === '11' || v === 'who11') return 'icd11';
  if (v === 'icd10gm' || v === '10gm' || v === 'icd10') return 'icd10gm';
  return fallback;
}

function clampLimit(value, def = 10, max = 50) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

module.exports = {
  getEnv,
  json,
  html,
  badRequest,
  serverError,
  normalizeSystem,
  clampLimit,
};
