'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bin', 'judge-updates');

function fixture(versions = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-judge-'));
  fs.mkdirSync(path.join(base, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(base, 'projects', 'demo', 's.jsonl'), versions.map((version) => JSON.stringify({ version })).join('\n') + '\n');
  return base;
}

function run(base, args, input) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: base };
  delete env.UPDATES_FILE;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { input, env, encoding: 'utf8' });
  return { code: res.status, out: res.stdout ? JSON.parse(res.stdout) : null, err: res.stderr };
}

const changelog = (versions) => versions.map((v) => `## ${v}\n- entry for ${v}`).join('\n\n');
const range = (n) => Array.from({ length: n }, (_, i) => `2.1.${200 + i}`);

test('prompt prints no batches when every version has a verdict', () => {
  const base = fixture(['2.1.286']);
  fs.mkdirSync(path.join(base, 'cc-dashboard'));
  fs.writeFileSync(path.join(base, 'cc-dashboard', 'updates.json'), JSON.stringify({ '2.1.286': { relevant: false } }));
  assert.deepStrictEqual(run(base, ['prompt'], changelog(['2.1.286'])), { code: 0, out: { batches: [] }, err: '' });
});

test('prompt splits pending transcript versions into batches of 20', () => {
  const versions = range(45);
  const { code, out } = run(fixture(versions), ['prompt'], changelog(versions));
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(out.batches.map((b) => b.versions.length), [20, 20, 5]);
  assert.strictEqual(out.batches[0].versions[0], '2.1.200');
  assert.match(out.batches[2].prompt, /## 2\.1\.244\n- entry for 2\.1\.244/);
  assert.match(out.batches[0].system, /JSON array/);
});

test('prompt --current adds a version no transcript has yet', () => {
  const { out } = run(fixture([]), ['prompt', '--current', '2.1.290'], changelog(['2.1.290']));
  assert.deepStrictEqual(out.batches.map((b) => b.versions), [['2.1.290']]);
});

test('record writes verdicts and prints the counts', () => {
  const base = fixture();
  const reply = JSON.stringify([
    { version: '2.1.286', relevant: true, summary: 'Cache shared' },
    { version: '2.1.287', relevant: false },
  ]);
  const { code, out } = run(base, ['record'], JSON.stringify({ versions: ['2.1.286', '2.1.287', '2.1.288'], reply }));
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(out, { recorded: 2, relevant: 1, unjudged: 1 });
  const saved = JSON.parse(fs.readFileSync(path.join(base, 'cc-dashboard', 'updates.json'), 'utf8'));
  assert.strictEqual(saved['2.1.286'].summary, 'Cache shared');
});

test('record exits 1 on stdin that is not JSON, and an unknown subcommand exits 1', () => {
  const bad = run(fixture(), ['record'], 'nope');
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /^judge-updates: /);
  assert.strictEqual(run(fixture(), ['judge'], '').code, 1);
});
