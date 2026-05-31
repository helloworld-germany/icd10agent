'use strict';

const icd10gm = require('./providers/icd10gmProvider');
const icd11 = require('./providers/icd11WhoProvider');

const PROVIDERS = { icd10gm, icd11 };

function getProvider(system) {
  const key = (system || 'icd10gm').toLowerCase();
  const p = PROVIDERS[key];
  if (!p) throw new Error(`Unknown system "${system}". Use "icd10gm" or "icd11".`);
  return { key, ...p };
}

module.exports = { getProvider };
