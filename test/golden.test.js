'use strict';

// Golden tests for the workstream F refactors of extractFile, aggregate and
// digestTranscript. Each output over the corpus in test/golden-corpus.js is compared
// with a file in test/fixtures written by the code before the refactor. Run with
// UPDATE_GOLDEN=1 to write the files again, and only when an output change is meant.

// Day and hour buckets use local time, so the zone is set before any Date is made.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');
const { NOW, writeCorpus } = require('./golden-corpus');
const { extractFile } = require('../lib/extract');
const { aggregate } = require('../lib/aggregate');
const { digestTranscript } = require('../lib/review');

const FIXTURES = path.join(__dirname, 'fixtures');

// The corpus folder is a new temp path on every run, so it is replaced by a fixed
// marker. The JSON round trip drops what JSON cannot hold, as a server response does.
function normalise(value, dir) {
  return JSON.parse(JSON.stringify(value).replaceAll(dir, '<corpus>'));
}

function checkGolden(name, actual) {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
  assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function extractAll(dir, names) {
  const out = {};
  for (const name of names) out[name] = await extractFile(path.join(dir, name));
  return out;
}

test('extractFile over the golden corpus matches test/fixtures/extract-golden.json', async (t) => {
  const dir = helpers.tmpDir(t, 'golden');
  const { shared } = writeCorpus(dir);
  checkGolden('extract-golden.json', normalise(await extractAll(dir, shared), dir));
});

// extractFile is async, so two row stores in one process can run it on different
// files at the same moment. No state may be shared between two calls.
test('extractFile over every corpus file at once gives the same rows as one at a time', async (t) => {
  const dir = helpers.tmpDir(t, 'golden');
  const { shared } = writeCorpus(dir);
  const together = await Promise.all(shared.map((name) => extractFile(path.join(dir, name))));
  assert.deepStrictEqual(normalise(Object.fromEntries(shared.map((name, i) => [name, together[i]])), dir), normalise(await extractAll(dir, shared), dir));
});

// The worker pool (lib/extract-pool.js) must give the same rows as a call on the main
// thread. The JSON round trip in normalise hides prototypes, so the null prototype of
// `sessions`, which structured clone drops, is checked directly.
test('extractFile over the golden corpus in worker threads matches test/fixtures/extract-golden.json', async (t) => {
  const { withPool } = require('../lib/extract-pool');
  const dir = helpers.tmpDir(t, 'golden');
  const { shared } = writeCorpus(dir);
  await withPool(3, async (pool) => {
    const results = await Promise.all(shared.map((name) => pool.extract(path.join(dir, name))));
    checkGolden('extract-golden.json', normalise(Object.fromEntries(shared.map((name, i) => [name, results[i]])), dir));
    for (const rows of results) assert.strictEqual(Object.getPrototypeOf(rows.sessions), null);
  });
});

test('aggregate over the golden corpus matches test/fixtures/aggregate-golden.json', async (t) => {
  const dir = helpers.tmpDir(t, 'golden');
  const { shared } = writeCorpus(dir);
  const entries = Object.values(await extractAll(dir, shared));
  const out = {
    all: aggregate(entries, { days: null, now: NOW, projectsDir: dir }),
    '30d': aggregate(entries, { days: 30, now: NOW }),
    '7d': aggregate(entries, { days: 7, now: NOW }),
    'today-hour': aggregate(entries, { days: 'today', bucket: 'hour', now: NOW }),
  };
  checkGolden('aggregate-golden.json', normalise(out, dir));
});

test('digestTranscript over the golden corpus matches test/fixtures/digest-golden.json', async (t) => {
  const dir = helpers.tmpDir(t, 'golden');
  const { shared, digestOnly } = writeCorpus(dir);
  const out = {};
  for (const name of [...shared, ...digestOnly]) out[name] = await digestTranscript(path.join(dir, name));
  checkGolden('digest-golden.json', normalise(out, dir));
});
