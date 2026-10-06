'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/scan.js reads CLAUDE_CONFIG_DIR when it loads, so each fixture gets fresh
// copies of every module that depends on it.
function load(base) {
  process.env.CLAUDE_CONFIG_DIR = base;
  delete process.env.REVIEWS_DIR;
  delete process.env.LIVE_SESSIONS_DIR;
  for (const m of ['../lib/scan', '../lib/sessions', '../lib/updates', '../lib/review']) {
    delete require.cache[require.resolve(m)];
  }
  return { review: require('../lib/review'), scan: require('../lib/scan') };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-review-'));

const typed = (text) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});

function writeTranscript(dir, lines, name = 's.jsonl') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('digestTranscript lists prompts, replies, tools, errors, large output and compactions in order', async () => {
  const base = tmpDir();
  const { review, scan } = load(base);
  const file = writeTranscript(base, [
    typed('fix the build'),
    say('Looking at the build.'),
    toolUse('t1', 'Read', { file_path: '/a.js' }),
    toolResult('t1', 'x'.repeat(12_000)),
    toolUse('t2', 'Bash', { command: 'ls -la' }),
    toolResult('t2', 'Exit code 1\nno such file', true),
    { type: 'system', subtype: 'compact_boundary' },
    { ...typed('summary of the earlier conversation'), isCompactSummary: true },
    typed('now commit'),
  ]);
  const bash = scan.toolDetail('Bash', { command: 'ls -la' });
  assert.deepStrictEqual(await review.digestTranscript(file), {
    prompts: 2,
    text: [
      'USER: fix the build',
      'CLAUDE: Looking at the build.',
      'TOOL Read /a.js',
      'LARGE OUTPUT Read: 12000 chars',
      bash ? `TOOL Bash ${bash}` : 'TOOL Bash',
      'ERROR Bash: Exit code 1 no such file',
      'COMPACTED',
      'USER: now commit',
    ].join('\n'),
  });
});

test('digestTranscript skips subagent lines, slash commands and repeated tool_use blocks', async () => {
  const base = tmpDir();
  const { review } = load(base);
  const file = writeTranscript(base, [
    typed('<command-name>/clear</command-name>'),
    { ...typed('a subagent task'), isSidechain: true },
    { ...toolUse('t9', 'Read', { file_path: '/sub.js' }), isSidechain: true },
    toolUse('t1', 'Read', { file_path: '/a.js' }),
    toolUse('t1', 'Read', { file_path: '/a.js' }),
  ]);
  assert.deepStrictEqual(await review.digestTranscript(file), { prompts: 0, text: 'TOOL Read /a.js' });
});

test('digestTranscript skips a line that is not JSON and reads on', async () => {
  const base = tmpDir();
  const { review } = load(base);
  const file = writeTranscript(base, [typed('first'), '{"type":"user","mess', typed('second')]);
  assert.deepStrictEqual(await review.digestTranscript(file), { prompts: 2, text: 'USER: first\nUSER: second' });
});

test('digestTranscript keeps the start and end of a long session', async () => {
  const base = tmpDir();
  const { review } = load(base);
  const lines = Array.from({ length: 400 }, (_, i) => typed(`p${i} ${'x'.repeat(300)}`));
  const { prompts, text } = await review.digestTranscript(writeTranscript(base, lines));
  assert.strictEqual(prompts, 400);
  assert.ok(text.startsWith('USER: p0 '));
  assert.ok(text.endsWith(`USER: p399 ${'x'.repeat(300)}`));
  assert.match(text, /\n\[\.\.\. \d+ characters cut \.\.\.\]\n/);
  assert.ok(text.length < 60_100);
});

test('digestTranscript returns null for a missing file', async () => {
  const base = tmpDir();
  const { review } = load(base);
  assert.strictEqual(await review.digestTranscript(path.join(base, 'gone.jsonl')), null);
});

test('parseReview accepts an empty list as no suggestions', () => {
  const { review } = load(tmpDir());
  assert.deepStrictEqual(review.parseReview('{"suggestions": []}'), []);
});

test('parseReview reads a fenced reply and collapses whitespace', () => {
  const { review } = load(tmpDir());
  const reply = '```json\n{"suggestions": [{"kind": "token-waste", "text": "Read  the file\\nonce."}, {"kind": "claude-md", "text": "Add a rule."}]}\n```';
  assert.deepStrictEqual(review.parseReview(reply), [
    { kind: 'token-waste', text: 'Read the file once.' },
    { kind: 'claude-md', text: 'Add a rule.' },
  ]);
});

test('parseReview drops unknown kinds and empty text, keeps at most 3, and cuts text to 300 chars', () => {
  const { review } = load(tmpDir());
  const items = [
    { kind: 'magic', text: 'dropped' },
    { kind: 'workflow', text: '   ' },
    { kind: 'workflow', text: 'a'.repeat(400) },
    { kind: 'skill-or-hook', text: 'two' },
    { kind: 'claude-md', text: 'three' },
    { kind: 'token-waste', text: 'four' },
  ];
  const out = review.parseReview(JSON.stringify({ suggestions: items }));
  assert.deepStrictEqual(out.map((s) => s.kind), ['workflow', 'skill-or-hook', 'claude-md']);
  assert.strictEqual(out[0].text.length, 300);
});

test('parseReview returns null for prose, a top-level array, or suggestions that are not a list', () => {
  const { review } = load(tmpDir());
  assert.strictEqual(review.parseReview('Nothing to suggest.'), null);
  assert.strictEqual(review.parseReview('[]'), null);
  assert.strictEqual(review.parseReview('{"suggestions": "none"}'), null);
  assert.strictEqual(review.parseReview('null'), null);
});

test('the system prompt names every kind and allows an empty list', () => {
  const { review } = load(tmpDir());
  for (const kind of review.KINDS) assert.ok(review.SYSTEM.includes(`"${kind}"`), kind);
  assert.ok(review.SYSTEM.includes('{"suggestions": []}'));
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 6, 12);

// A snapshot the way lib/sessions.js writes it, with endedAt when the session ended.
function writeSnapshot(dir, s) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.sessionId}.json`), JSON.stringify(s));
}

function fixture() {
  const base = tmpDir();
  const mods = load(base);
  return {
    ...mods,
    base,
    sessionsDir: path.join(base, 'cc-dashboard', 'sessions'),
    dir: path.join(base, 'cc-dashboard', 'reviews'),
    projects: path.join(base, 'projects'),
  };
}

function writeSessionTranscript(projects, id, promptCount) {
  const folder = path.join(projects, '-work-demo');
  fs.mkdirSync(folder, { recursive: true });
  writeTranscript(folder, Array.from({ length: promptCount }, (_, i) => typed(`prompt ${i}`)), `${id}.jsonl`);
}

test('getReviewsDir is under the config dir unless REVIEWS_DIR is set', () => {
  const { review, base } = fixture();
  assert.strictEqual(review.getReviewsDir(), path.join(base, 'cc-dashboard', 'reviews'));
  process.env.REVIEWS_DIR = '~/elsewhere';
  assert.strictEqual(review.getReviewsDir(), path.join(os.homedir(), 'elsewhere'));
  delete process.env.REVIEWS_DIR;
});

test('endedSessions lists ended snapshots, newest end first, and skips the rest', () => {
  const { review, sessionsDir } = fixture();
  writeSnapshot(sessionsDir, { sessionId: 'a', project: 'demo', endedAt: 100 });
  writeSnapshot(sessionsDir, { sessionId: 'b', project: 'demo', endedAt: 300 });
  writeSnapshot(sessionsDir, { sessionId: 'live', project: 'demo' });
  fs.writeFileSync(path.join(sessionsDir, 'c.json.123'), JSON.stringify({ sessionId: 'c', endedAt: 200 }));
  fs.writeFileSync(path.join(sessionsDir, 'bad.json'), JSON.stringify({ sessionId: '../x', endedAt: 200 }));
  assert.deepStrictEqual(review.endedSessions(sessionsDir), [
    { sessionId: 'b', project: 'demo', endedAt: 300 },
    { sessionId: 'a', project: 'demo', endedAt: 100 },
  ]);
});

test('endedSessions returns an empty list when the sessions folder is missing', () => {
  const { review, base } = fixture();
  assert.deepStrictEqual(review.endedSessions(path.join(base, 'nope')), []);
});

test('claimReview lets only the first of two claims win', () => {
  const { review, dir } = fixture();
  const session = { sessionId: 'a', project: 'demo', endedAt: 100 };
  assert.strictEqual(review.claimReview(session, dir, NOW), true);
  assert.strictEqual(review.claimReview(session, dir, NOW), false);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  assert.deepStrictEqual(saved, { ...session, status: 'pending', claimedAt: NOW });
});

test('claimReview takes back a pending or failed review after an hour, never a done or skipped one', () => {
  const { review, dir } = fixture();
  for (const [id, status] of [['p', 'pending'], ['f', 'failed'], ['d', 'done'], ['s', 'skipped']]) {
    review.claimReview({ sessionId: id, project: null, endedAt: 1 }, dir, NOW);
    if (status !== 'pending') review.finishReview(id, { status }, dir, NOW);
  }
  const at = (ms) => ['p', 'f', 'd', 's'].map((id) => review.claimReview({ sessionId: id, project: null, endedAt: 1 }, dir, NOW + ms));
  assert.deepStrictEqual(at(HOUR - 1), [false, false, false, false]);
  assert.deepStrictEqual(at(HOUR + 1), [true, true, false, false]);
});

test('finishReview adds the outcome and reviewedAt, and refuses a review that was never claimed', () => {
  const { review, dir } = fixture();
  review.claimReview({ sessionId: 'a', project: 'demo', endedAt: 100 }, dir, NOW);
  assert.strictEqual(review.finishReview('a', { status: 'done', suggestions: [] }, dir, NOW + 5), true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  assert.deepStrictEqual(saved, { sessionId: 'a', project: 'demo', endedAt: 100, status: 'done', claimedAt: NOW, suggestions: [], reviewedAt: NOW + 5 });
  assert.strictEqual(review.finishReview('never', { status: 'done' }, dir, NOW), false);
});

test('pendingReviews returns sessions with 3 or more prompts and records the rest as skipped', async () => {
  const { review, sessionsDir, dir, projects } = fixture();
  writeSnapshot(sessionsDir, { sessionId: 'big', project: 'demo', endedAt: 300 });
  writeSnapshot(sessionsDir, { sessionId: 'small', project: 'demo', endedAt: 200 });
  writeSnapshot(sessionsDir, { sessionId: 'lost', project: 'demo', endedAt: 100 });
  writeSnapshot(sessionsDir, { sessionId: 'running', project: 'demo' });
  writeSessionTranscript(projects, 'big', 3);
  writeSessionTranscript(projects, 'small', 2);
  writeSessionTranscript(projects, 'running', 5);

  const reviews = await review.pendingReviews({ sessionsDir, dir, projects, now: NOW });
  assert.deepStrictEqual(reviews, [{ sessionId: 'big', system: review.SYSTEM, prompt: 'USER: prompt 0\nUSER: prompt 1\nUSER: prompt 2' }]);
  const status = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  assert.strictEqual(status('big').status, 'pending');
  assert.deepStrictEqual([status('small').status, status('small').reason], ['skipped', 'under 3 prompts']);
  assert.deepStrictEqual([status('lost').status, status('lost').reason], ['skipped', 'no transcript']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'running.json')), false);

  assert.deepStrictEqual(await review.pendingReviews({ sessionsDir, dir, projects, now: NOW }), []);
});

test('pendingReviews hands back at most 3 sessions per run', async () => {
  const { review, sessionsDir, dir, projects } = fixture();
  for (let i = 0; i < 5; i++) {
    writeSnapshot(sessionsDir, { sessionId: `s${i}`, project: 'demo', endedAt: i });
    writeSessionTranscript(projects, `s${i}`, 3);
  }
  const first = await review.pendingReviews({ sessionsDir, dir, projects, now: NOW });
  assert.deepStrictEqual(first.map((r) => r.sessionId), ['s4', 's3', 's2']);
  const second = await review.pendingReviews({ sessionsDir, dir, projects, now: NOW });
  assert.deepStrictEqual(second.map((r) => r.sessionId), ['s1', 's0']);
});

test('recordReview stores suggestions, a format failure, or an error', () => {
  const { review, dir } = fixture();
  for (const id of ['a', 'b', 'c']) review.claimReview({ sessionId: id, project: 'demo', endedAt: 1 }, dir, NOW);
  const reply = JSON.stringify({ suggestions: [{ kind: 'workflow', text: 'Plan first.' }] });
  assert.deepStrictEqual(review.recordReview({ sessionId: 'a', reply }, dir, NOW), { status: 'done', suggestions: 1 });
  assert.deepStrictEqual(review.recordReview({ sessionId: 'b', reply: 'Looks fine!' }, dir, NOW), { status: 'failed', suggestions: 0 });
  assert.deepStrictEqual(review.recordReview({ sessionId: 'c', error: 'Haiku gave no answer (empty-reply)' }, dir, NOW), { status: 'failed', suggestions: 0 });
  const saved = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  assert.deepStrictEqual(saved('a').suggestions, [{ kind: 'workflow', text: 'Plan first.' }]);
  assert.strictEqual(saved('b').error, 'Haiku did not answer in the asked-for format');
  assert.strictEqual(saved('c').error, 'Haiku gave no answer (empty-reply)');
});

test('recordReview throws on a bad session id, a missing outcome, or no claim', () => {
  const { review, dir } = fixture();
  assert.throws(() => review.recordReview({ sessionId: '../x', reply: '{}' }, dir, NOW), /session id/);
  review.claimReview({ sessionId: 'a', project: null, endedAt: 1 }, dir, NOW);
  assert.throws(() => review.recordReview({ sessionId: 'a' }, dir, NOW), /expected/);
  assert.throws(() => review.recordReview({ sessionId: 'never', reply: '{"suggestions":[]}' }, dir, NOW), /no claimed review/);
});

test('readReviews lists done and failed reviews from the last 7 days without session ids', () => {
  const { review, dir } = fixture();
  const write = (id, fields) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ sessionId: id, project: 'demo', ...fields }));
  };
  write('done', { endedAt: NOW - 2 * HOUR, reviewedAt: NOW - HOUR, status: 'done', suggestions: [{ kind: 'workflow', text: 'x' }, { kind: 'bogus', text: 'y' }] });
  write('failed', { endedAt: NOW - HOUR, reviewedAt: NOW - HOUR, status: 'failed', error: 'Haiku call failed (Error)' });
  write('skipped', { endedAt: NOW - HOUR, reviewedAt: NOW - HOUR, status: 'skipped', reason: 'under 3 prompts' });
  write('pending', { endedAt: NOW - HOUR, status: 'pending', claimedAt: NOW });
  write('old', { endedAt: NOW - 8 * DAY, reviewedAt: NOW - 8 * DAY, status: 'done', suggestions: [] });
  assert.deepStrictEqual(review.readReviews(dir, NOW), [
    { project: 'demo', endedAt: NOW - HOUR, reviewedAt: NOW - HOUR, status: 'failed', suggestions: [], error: 'Haiku call failed (Error)' },
    { project: 'demo', endedAt: NOW - 2 * HOUR, reviewedAt: NOW - HOUR, status: 'done', suggestions: [{ kind: 'workflow', text: 'x' }] },
  ]);
});

test('readReviews returns an empty list when the reviews folder is missing', () => {
  const { review, base } = fixture();
  assert.deepStrictEqual(review.readReviews(path.join(base, 'nope'), NOW), []);
});

test('pruneReviews deletes review files older than 7 days', () => {
  const { review, dir } = fixture();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['old.json', 'new.json', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '{}');
  const eightDaysAgo = (NOW - 8 * DAY) / 1000;
  fs.utimesSync(path.join(dir, 'old.json'), eightDaysAgo, eightDaysAgo);
  fs.utimesSync(path.join(dir, 'notes.txt'), eightDaysAgo, eightDaysAgo);
  fs.utimesSync(path.join(dir, 'new.json'), NOW / 1000, NOW / 1000);
  review.pruneReviews(dir, NOW);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['new.json', 'notes.txt']);
});
