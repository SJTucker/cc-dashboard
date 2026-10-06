'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readRecord, writeRecord, clearRecord, RECORD_TTL_MS } = require('../lib/records');

const RECORD = { date: '2026-09-30', tokens: 5000, cost: 1.25 };

// Points RECORDS_FILE at a file in a fresh directory that does not exist yet, so
// writeRecord has to create it. Restores the variable after the test.
function useTempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-records-'));
  const file = path.join(dir, 'nested', 'records.json');
  const previous = process.env.RECORDS_FILE;
  process.env.RECORDS_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.RECORDS_FILE;
    else process.env.RECORDS_FILE = previous;
  });
  return file;
}

test('readRecord returns null when there is no file', (t) => {
  useTempFile(t);
  assert.strictEqual(readRecord(), null);
});

test('writeRecord creates the directory, and readRecord returns the same record', (t) => {
  const file = useTempFile(t);
  writeRecord(RECORD, 1000);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { allTime: RECORD, computedAt: 1000 });
  assert.deepStrictEqual(readRecord(1000), RECORD);
});

test('readRecord returns null for a file that is not a record', (t) => {
  const file = useTempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['not json', 'null', '[]', '{"allTime":null,"computedAt":1}', '{"allTime":{"tokens":"5"},"computedAt":1}', '{"allTime":{"tokens":5}}', '{"allTime":{"tokens":5,"cost":1},"computedAt":1}', '{"allTime":{"date":"2026-01-01","tokens":5},"computedAt":1}']) {
    fs.writeFileSync(file, text);
    assert.strictEqual(readRecord(1), null, text);
  }
});

test('readRecord returns the record until it is 3 days old, then null', (t) => {
  useTempFile(t);
  writeRecord(RECORD, 1000);
  assert.deepStrictEqual(readRecord(1000 + RECORD_TTL_MS - 1), RECORD);
  assert.strictEqual(readRecord(1000 + RECORD_TTL_MS), null);
});

test('clearRecord deletes the file, and does nothing when it is missing', (t) => {
  const file = useTempFile(t);
  writeRecord(RECORD);
  clearRecord();
  assert.strictEqual(fs.existsSync(file), false);
  assert.doesNotThrow(() => clearRecord());
});
