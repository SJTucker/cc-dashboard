'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('../lib/sqlite');
const { SCHEMA_VERSION } = require('../lib/db');

const SCRIPT = path.join(__dirname, '..', 'bin', 'review-session');

const typed = (text) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });

// A config dir holding one ended session with three typed prompts.
function fixture() {
  const base = helpers.tmpDir(null, 'review-bin');
  const sessions = path.join(base, 'cc-dashboard', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'abc.json'), JSON.stringify({ sessionId: 'abc', project: 'demo', endedAt: Date.now() }));
  fs.mkdirSync(path.join(base, 'projects', '-work-demo'), { recursive: true });
  fs.writeFileSync(path.join(base, 'projects', '-work-demo', 'abc.jsonl'), ['one', 'two', 'three'].map(typed).join('\n') + '\n');
  return base;
}

function run(base, args, input = '') {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: base };
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { input, env, encoding: 'utf8' });
  return { code: res.status, out: res.stdout ? JSON.parse(res.stdout) : null, err: res.stderr };
}

test('prompt hands back the ended session and record stores the answer', () => {
  const base = fixture();
  const prompted = run(base, ['prompt']);
  assert.strictEqual(prompted.code, 0);
  assert.deepStrictEqual(prompted.out.reviews.map((r) => r.sessionId), ['abc']);
  assert.strictEqual(prompted.out.reviews[0].prompt, 'USER: one\nUSER: two\nUSER: three');
  assert.match(prompted.out.reviews[0].system, /"suggestions": \[\]/);

  const reply = JSON.stringify({ suggestions: [] });
  assert.deepStrictEqual(run(base, ['record'], JSON.stringify({ sessionId: 'abc', reply })), {
    code: 0, out: { status: 'done', suggestions: 0 }, err: '',
  });
  const check = new DatabaseSync(path.join(base, 'cc-dashboard', 'transcripts.db'));
  assert.strictEqual(check.prepare("SELECT status FROM reviews WHERE session_id = 'abc'").get().status, 'done');
  check.close();
  assert.strictEqual(fs.existsSync(path.join(base, 'cc-dashboard', 'reviews')), false);

  assert.deepStrictEqual(run(base, ['prompt']).out, { reviews: [] });
});

test('prompt sends the global CLAUDE.md ahead of the digest', () => {
  const base = fixture();
  fs.writeFileSync(path.join(base, 'CLAUDE.md'), 'Commits carry no trailer.');
  const prompted = run(base, ['prompt']);
  assert.strictEqual(prompted.code, 0);
  assert.strictEqual(
    prompted.out.reviews[0].prompt,
    `RULES THE USER ALREADY HAS\n=== ${path.join(base, 'CLAUDE.md')} ===\nCommits carry no trailer.\n\nSESSION DIGEST\nUSER: one\nUSER: two\nUSER: three`,
  );
});

test('record exits 1 with the reason on bad stdin', () => {
  const { code, out, err } = run(fixture(), ['record'], 'nope');
  assert.strictEqual(code, 1);
  assert.strictEqual(out, null);
  assert.match(err, /^review-session: /);
});

test('an unknown subcommand prints usage and exits 1', () => {
  const { code, err } = run(fixture(), ['judge']);
  assert.strictEqual(code, 1);
  assert.match(err, /^review-session: usage: review-session prompt \| record/);
});

test('two prompt runs at once hand a session to exactly one of them', async () => {
  const base = fixture();
  const { spawn } = require('child_process');
  const once = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, 'prompt'], { env: { ...process.env, CLAUDE_CONFIG_DIR: base } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, reviews: JSON.parse(out).reviews.length }));
  });
  const results = await Promise.all([once(), once(), once()]);
  assert.deepStrictEqual(results.map((r) => r.code), [0, 0, 0]);
  assert.strictEqual(results.reduce((n, r) => n + r.reviews, 0), 1);
});

test('review files from an earlier version are imported once and left on disk', () => {
  const base = fixture();
  const legacy = path.join(base, 'cc-dashboard', 'reviews');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'old1.json'), JSON.stringify({ sessionId: 'old1', status: 'done', reviewedAt: Date.now(), suggestions: [{ kind: 'workflow', text: 'x' }] }));
  assert.deepStrictEqual(run(base, ['prompt']).out.reviews.map((r) => r.sessionId), ['abc']);
  const check = new DatabaseSync(path.join(base, 'cc-dashboard', 'transcripts.db'));
  assert.strictEqual(check.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE session_id = 'old1'").get().n, 1);
  check.close();
  assert.deepStrictEqual(fs.readdirSync(legacy), ['old1.json']);
});

test('an unopenable transcripts.db exits 1 with one line on stderr and nothing on stdout', () => {
  const base = fixture();
  fs.writeFileSync(path.join(base, 'cc-dashboard', 'transcripts.db'), 'not a database '.repeat(100));
  const { code, out, err } = run(base, ['prompt']);
  assert.strictEqual(code, 1);
  assert.strictEqual(out, null);
  assert.match(err, /^review-session: cannot open .*transcripts\.db: .+\n$/);
  assert.strictEqual(err.trim().split('\n').length, 1);
});

test('a newer schema exits 1 and the file is unchanged', () => {
  const base = fixture();
  const file = path.join(base, 'cc-dashboard', 'transcripts.db');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema', '${SCHEMA_VERSION + 1}');`);
  raw.close();
  const before = fs.readFileSync(file);
  const { code, err } = run(base, ['record'], JSON.stringify({ sessionId: 'abc', reply: '{"suggestions":[]}' }));
  assert.strictEqual(code, 1);
  assert.match(err, new RegExp(`newer than this dashboard's ${SCHEMA_VERSION}`));
  assert.ok(fs.readFileSync(file).equals(before));
});
