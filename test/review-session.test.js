'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bin', 'review-session');

const typed = (text) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });

// A config dir holding one ended session with three typed prompts.
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-review-bin-'));
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
  const saved = JSON.parse(fs.readFileSync(path.join(base, 'cc-dashboard', 'reviews', 'abc.json'), 'utf8'));
  assert.strictEqual(saved.status, 'done');

  assert.deepStrictEqual(run(base, ['prompt']).out, { reviews: [] });
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
