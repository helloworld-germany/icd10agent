'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rows = [
  { Code: 'I10', Display: 'Essentielle (primäre) Hypertonie', classKind: 'category', child: 'I10.9' },
  { Code: 'I10.90', Display: 'Essentielle Hypertonie, nicht näher bezeichnet: Ohne Angabe einer hypertensiven Krise', classKind: 'category', child: '' },
  { Code: 'I10.91', Display: 'Essentielle Hypertonie, nicht näher bezeichnet: Mit Angabe einer hypertensiven Krise', classKind: 'category', child: '' },
  { Code: 'I27.01', Display: 'Pulmonale arterielle Hypertonie assoziiert mit angeborenem Herzfehler', classKind: 'category', child: '' },
  { Code: 'I99.9', Display: 'Nicht kodierbare Hypertonie-Gruppe', classKind: 'category', child: '', Para301: 'V' },
  { Code: 'A04.70', Display: 'Enterokolitis durch Clostridium difficile ohne Megakolon', classKind: 'category', child: '' },
  { Code: 'E10.90', Display: 'Diabetes mellitus, Typ 1: Ohne Komplikationen', classKind: 'category', child: '' },
  { Code: 'E11.90', Display: 'Diabetes mellitus, Typ 2: Ohne Komplikationen', classKind: 'category', child: '' },
  { Code: 'J44.9', Display: 'Chronische obstruktive Lungenkrankheit, nicht näher bezeichnet', classKind: 'category', child: '', designation: [{ value: 'COPD' }] },
];

global.fetch = async () => ({
  ok: true,
  json: async () => ({ version: 'test', rows }),
});

const provider = require('../shared/providers/icd10gmProvider');

test('excludes unrelated rows from text search', async () => {
  const { results } = await provider.search('Arterielle Hypertension', 20);
  assert.ok(results.some(result => result.code.startsWith('I10.')));
  assert.ok(results.some(result => result.code === 'I27.01'));
  assert.ok(results.every(result => result.code !== 'A04.70'));
});

test('does not return non-terminal grouping categories', async () => {
  const { results } = await provider.search('Hypertonie', 20);
  assert.ok(results.some(result => result.code === 'I10.90'));
  assert.ok(results.every(result => result.code !== 'I10'));
  assert.ok(results.every(result => result.code !== 'I99.9'));
});

test('keeps explicit pulmonary hypertension discoverable', async () => {
  const { results } = await provider.search('pulmonale arterielle Hypertonie', 5);
  assert.equal(results[0].code, 'I27.01');
});

test('supports exact code lookup and prefix search', async () => {
  const exact = await provider.getCode('I10.90');
  assert.equal(exact.result.code, 'I10.90');

  const { results } = await provider.search('I10', 10);
  assert.ok(results.some(result => result.code === 'I10.90'));
  assert.ok(results.every(result => result.code.startsWith('I10')));
});

test('uses numeric tokens to distinguish diagnosis types', async () => {
  const { results } = await provider.search('Diabetes mellitus Typ 2', 5);
  assert.equal(results[0].code, 'E11.90');
});

test('expands configured multi-word equivalents', async () => {
  const { results } = await provider.search('Zuckerkrankheit', 5);
  assert.ok(results.some(result => result.code === 'E11.90'));
});

test('searches official designation fields when present', async () => {
  const { results } = await provider.search('COPD', 5);
  assert.equal(results[0].code, 'J44.9');
});

test('tolerates minor spelling mistakes', async () => {
  const { results } = await provider.search('Diabetis mellitus Typ 2', 5);
  assert.equal(results[0].code, 'E11.90');
});

test('returns no results for an unrelated query', async () => {
  const { results } = await provider.search('Quantenbanane', 20);
  assert.deepEqual(results, []);
});
