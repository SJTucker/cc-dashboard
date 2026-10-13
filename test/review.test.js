'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { toolDetail } = require('../lib/extract');

const review = require('../lib/review');
const reviewDb = require('../lib/review-db');

const tmpDir = () => helpers.tmpDir(null, 'review');

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
  const bash = toolDetail('Bash', { command: 'ls -la' });
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
  const file = writeTranscript(base, [typed('first'), '{"type":"user","mess', typed('second')]);
  assert.deepStrictEqual(await review.digestTranscript(file), { prompts: 2, text: 'USER: first\nUSER: second' });
});

test('digestTranscript skips a line that is JSON but not an object', async () => {
  const base = tmpDir();
  const file = writeTranscript(base, [typed('first'), 'null', '42', '[]', typed('second')]);
  assert.deepStrictEqual(await review.digestTranscript(file), { prompts: 2, text: 'USER: first\nUSER: second' });
});

test('digestTranscript keeps the start and end of a long session', async () => {
  const base = tmpDir();
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
  assert.strictEqual(await review.digestTranscript(path.join(base, 'gone.jsonl')), null);
});

test('parseReview accepts an empty list as no suggestions', () => {
  assert.deepStrictEqual(review.parseReview('{"suggestions": []}'), []);
});

test('parseReview reads a fenced reply and collapses whitespace', () => {
  const reply = '```json\n{"suggestions": [{"kind": "token-waste", "text": "Read  the file\\nonce."}, {"kind": "claude-md", "text": "Add a rule."}]}\n```';
  assert.deepStrictEqual(review.parseReview(reply), [
    { kind: 'token-waste', text: 'Read the file once.' },
    { kind: 'claude-md', text: 'Add a rule.' },
  ]);
});

test('parseReview drops unknown kinds and empty text, keeps at most 3, and cuts text to 300 chars', () => {
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
  assert.strictEqual(review.parseReview('Nothing to suggest.'), null);
  assert.strictEqual(review.parseReview('[]'), null);
  assert.strictEqual(review.parseReview('{"suggestions": "none"}'), null);
  assert.strictEqual(review.parseReview('null'), null);
});

test('the system prompt names every kind and allows an empty list', () => {
  for (const kind of review.KINDS) assert.ok(review.SYSTEM.includes(`"${kind}"`), kind);
  assert.ok(review.SYSTEM.includes('{"suggestions": []}'));
});

test('SYSTEM explains the rules section and asks for broken rules', () => {
  assert.match(review.SYSTEM, /RULES THE USER ALREADY HAS/);
  assert.match(review.SYSTEM, /already state/);
  assert.match(review.SYSTEM, /Broken rule:/);
  assert.match(review.SYSTEM, /hook that enforces/);
  assert.match(review.SYSTEM, /changed after the session started/);
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
  return {
    review,
    base,
    db: reviewDb.openReviewDb(path.join(base, 'transcripts.db'), path.join(base, 'cc-dashboard', 'reviews')),
    sessionsDir: path.join(base, 'cc-dashboard', 'sessions'),
    projects: path.join(base, 'projects'),
  };
}

const rowOf = (db, id) => {
  const row = db.prepare('SELECT * FROM reviews WHERE session_id = ?').get(id);
  return row ? { ...row } : row; // node:sqlite rows have a null prototype
};
const suggestionsOf = (db, id) => db.prepare('SELECT idx, kind, text, dismissed_at, reason FROM suggestions WHERE session_id = ? ORDER BY idx').all(id).map((r) => ({ ...r }));

function writeSessionTranscript(projects, id, promptCount) {
  const folder = path.join(projects, '-work-demo');
  fs.mkdirSync(folder, { recursive: true });
  writeTranscript(folder, Array.from({ length: promptCount }, (_, i) => typed(`prompt ${i}`)), `${id}.jsonl`);
}

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
  const { review, db } = fixture();
  const session = { sessionId: 'a', project: 'demo', endedAt: 100 };
  assert.strictEqual(review.claimReview(db, session, NOW), true);
  assert.strictEqual(review.claimReview(db, session, NOW), false);
  assert.deepStrictEqual(rowOf(db, 'a'), {
    session_id: 'a', project: 'demo', ended_at: 100, status: 'pending', claimed_at: NOW, reviewed_at: null,
    transcript: null, title: null, branch: null, skip_reason: null, error: null,
  });
});

test('claimReview takes back a pending or failed review after an hour, never a done or skipped one', () => {
  const { review, db } = fixture();
  for (const [id, status] of [['p', 'pending'], ['f', 'failed'], ['d', 'done'], ['s', 'skipped']]) {
    review.claimReview(db, { sessionId: id, project: null, endedAt: 1 }, NOW);
    if (status !== 'pending') review.finishReview(db, id, { status }, NOW);
  }
  const at = (ms) => ['p', 'f', 'd', 's'].map((id) => review.claimReview(db, { sessionId: id, project: null, endedAt: 1 }, NOW + ms));
  assert.deepStrictEqual(at(HOUR - 1), [false, false, false, false]);
  assert.deepStrictEqual(at(HOUR + 1), [true, true, false, false]);
});

test('a retaken claim clears the old outcome, and a second retake at the same moment loses', () => {
  const { review, db } = fixture();
  review.claimReview(db, { sessionId: 'f', project: 'demo', endedAt: 1 }, NOW);
  review.updateReview(db, 'f', { transcript: '/t.jsonl', title: 'T', branch: 'b' });
  review.finishReview(db, 'f', { status: 'failed', error: 'boom' }, NOW);
  const again = { sessionId: 'f', project: 'demo', endedAt: 1 };
  assert.strictEqual(review.claimReview(db, again, NOW + 2 * HOUR), true);
  assert.strictEqual(review.claimReview(db, again, NOW + 2 * HOUR), false);
  const row = rowOf(db, 'f');
  assert.deepStrictEqual([row.status, row.claimed_at, row.reviewed_at, row.error, row.transcript, row.title], ['pending', NOW + 2 * HOUR, null, null, null, null]);
});

test('finishReview writes the outcome, reviewedAt and numbered suggestions, and refuses a review that was never claimed', () => {
  const { review, db } = fixture();
  review.claimReview(db, { sessionId: 'a', project: 'demo', endedAt: 100 }, NOW);
  const suggestions = [{ kind: 'workflow', text: 'one' }, { kind: 'token-waste', text: 'two' }];
  assert.strictEqual(review.finishReview(db, 'a', { status: 'done', suggestions }, NOW + 5), true);
  assert.deepStrictEqual([rowOf(db, 'a').status, rowOf(db, 'a').reviewed_at, rowOf(db, 'a').claimed_at], ['done', NOW + 5, NOW]);
  assert.deepStrictEqual(suggestionsOf(db, 'a'), [
    { idx: 0, kind: 'workflow', text: 'one', dismissed_at: null, reason: null },
    { idx: 1, kind: 'token-waste', text: 'two', dismissed_at: null, reason: null },
  ]);
  assert.strictEqual(review.finishReview(db, 'never', { status: 'done', suggestions }, NOW), false);
  assert.deepStrictEqual(suggestionsOf(db, 'never'), []);
});

test('a second finishReview for a finished review returns false and keeps its suggestions and dismissals', () => {
  const { review, db } = fixture();
  review.claimReview(db, { sessionId: 'a', project: 'demo', endedAt: 100 }, NOW);
  review.finishReview(db, 'a', { status: 'done', suggestions: [{ kind: 'workflow', text: 'one' }, { kind: 'token-waste', text: 'two' }] }, NOW + 5);
  db.prepare("UPDATE suggestions SET dismissed_at = ?, reason = 'done' WHERE session_id = 'a' AND idx = 0").run(NOW + 6);
  const before = suggestionsOf(db, 'a');
  const rowBefore = rowOf(db, 'a');
  assert.strictEqual(review.finishReview(db, 'a', { status: 'failed', error: 'late', suggestions: [{ kind: 'claude-md', text: 'other' }] }, NOW + 9), false);
  assert.deepStrictEqual(suggestionsOf(db, 'a'), before);
  assert.strictEqual(before[0].dismissed_at, NOW + 6);
  assert.deepStrictEqual(rowOf(db, 'a'), rowBefore);
});

test('pendingReviews returns sessions with 3 or more prompts and records the rest as skipped', async () => {
  const { review, db, sessionsDir, projects } = fixture();
  writeSnapshot(sessionsDir, { sessionId: 'big', project: 'demo', endedAt: NOW - 1 });
  writeSnapshot(sessionsDir, { sessionId: 'small', project: 'demo', endedAt: NOW - 2 });
  writeSnapshot(sessionsDir, { sessionId: 'lost', project: 'demo', endedAt: NOW - 3 });
  writeSnapshot(sessionsDir, { sessionId: 'running', project: 'demo' });
  writeSessionTranscript(projects, 'big', 3);
  writeSessionTranscript(projects, 'small', 2);
  writeSessionTranscript(projects, 'running', 5);

  const reviews = await review.pendingReviews({ db, sessionsDir, projects, now: NOW });
  assert.deepStrictEqual(reviews, [{ sessionId: 'big', system: review.SYSTEM, prompt: 'USER: prompt 0\nUSER: prompt 1\nUSER: prompt 2' }]);
  assert.strictEqual(rowOf(db, 'big').status, 'pending');
  assert.deepStrictEqual([rowOf(db, 'small').status, rowOf(db, 'small').skip_reason], ['skipped', 'under 3 prompts']);
  assert.deepStrictEqual([rowOf(db, 'lost').status, rowOf(db, 'lost').skip_reason], ['skipped', 'no transcript']);
  assert.strictEqual(rowOf(db, 'running'), undefined);
  assert.deepStrictEqual(await review.pendingReviews({ db, sessionsDir, projects, now: NOW }), []);
});

test('pendingReviews puts the session rule files ahead of the digest', async () => {
  const { review, base, db, sessionsDir, projects } = fixture();
  const cfg = path.join(base, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), 'Never push without asking.');
  const app = path.join(base, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'CLAUDE.md'), 'Run npm test.');
  const folder = path.join(projects, '-work-demo');
  fs.mkdirSync(path.join(folder, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'memory', 'MEMORY.md'), '- [Floor](floor.md) — Node 22.13');
  writeSnapshot(sessionsDir, { sessionId: 'big', project: 'demo', endedAt: NOW - 1 });
  writeTranscript(folder, [{ ...typed('prompt 0'), cwd: app }, typed('prompt 1'), typed('prompt 2')], 'big.jsonl');

  const [only] = await review.pendingReviews({ db, sessionsDir, projects, configDir: cfg, now: NOW });
  assert.strictEqual(only.prompt, [
    'RULES THE USER ALREADY HAS',
    `=== ${path.join(cfg, 'CLAUDE.md')} ===`,
    'Never push without asking.',
    '',
    `=== ${path.join(app, 'CLAUDE.md')} ===`,
    'Run npm test.',
    '',
    `=== ${path.join(folder, 'memory', 'MEMORY.md')} ===`,
    '- [Floor](floor.md) — Node 22.13',
    '',
    'SESSION DIGEST',
    'USER: prompt 0\nUSER: prompt 1\nUSER: prompt 2',
  ].join('\n'));
});

test('pendingReviews reads each transcript file once', async () => {
  const { review, db, sessionsDir, projects } = fixture();
  writeSnapshot(sessionsDir, { sessionId: 'big', project: 'demo', endedAt: NOW - 1 });
  writeSessionTranscript(projects, 'big', 3);
  const opened = [];
  const original = fs.createReadStream;
  fs.createReadStream = (file, ...rest) => {
    opened.push(String(file));
    return original.call(fs, file, ...rest);
  };
  try {
    await review.pendingReviews({ db, sessionsDir, projects, now: NOW });
  } finally {
    fs.createReadStream = original;
  }
  assert.strictEqual(opened.filter((f) => f.endsWith('big.jsonl')).length, 1);
});

test('pendingReviews skips a session that ended more than 7 days ago', async () => {
  const { review, db, sessionsDir, projects } = fixture();
  writeSnapshot(sessionsDir, { sessionId: 'stale', project: 'demo', endedAt: NOW - 8 * DAY });
  writeSessionTranscript(projects, 'stale', 3);
  assert.deepStrictEqual(await review.pendingReviews({ db, sessionsDir, projects, now: NOW }), []);
  assert.strictEqual(rowOf(db, 'stale'), undefined);
});

test('pendingReviews hands back at most 3 sessions per run', async () => {
  const { review, db, sessionsDir, projects } = fixture();
  for (let i = 0; i < 5; i++) {
    writeSnapshot(sessionsDir, { sessionId: `s${i}`, project: 'demo', endedAt: NOW - 100 + i });
    writeSessionTranscript(projects, `s${i}`, 3);
  }
  assert.deepStrictEqual((await review.pendingReviews({ db, sessionsDir, projects, now: NOW })).map((r) => r.sessionId), ['s4', 's3', 's2']);
  assert.deepStrictEqual((await review.pendingReviews({ db, sessionsDir, projects, now: NOW })).map((r) => r.sessionId), ['s1', 's0']);
});

test('pendingReviews does not delete or rewrite old rows', async () => {
  const { review, db, sessionsDir, projects } = fixture();
  review.claimReview(db, { sessionId: 'ancient', project: 'demo', endedAt: 1 }, NOW - 30 * DAY);
  review.finishReview(db, 'ancient', { status: 'done', suggestions: [{ kind: 'workflow', text: 'x' }] }, NOW - 30 * DAY);
  await review.pendingReviews({ db, sessionsDir, projects, now: NOW });
  assert.strictEqual(rowOf(db, 'ancient').status, 'done');
  assert.strictEqual(suggestionsOf(db, 'ancient').length, 1);
});

test('recordReview stores suggestions, a format failure, or an error', () => {
  const { review, db } = fixture();
  for (const id of ['a', 'b', 'c']) review.claimReview(db, { sessionId: id, project: 'demo', endedAt: 1 }, NOW);
  const reply = JSON.stringify({ suggestions: [{ kind: 'workflow', text: 'Plan first.' }] });
  assert.deepStrictEqual(review.recordReview(db, { sessionId: 'a', reply }, NOW), { status: 'done', suggestions: 1 });
  assert.deepStrictEqual(review.recordReview(db, { sessionId: 'b', reply: 'Looks fine!' }, NOW), { status: 'failed', suggestions: 0 });
  assert.deepStrictEqual(review.recordReview(db, { sessionId: 'c', error: 'Haiku gave no answer (empty-reply)' }, NOW), { status: 'failed', suggestions: 0 });
  assert.deepStrictEqual(suggestionsOf(db, 'a').map((s) => s.text), ['Plan first.']);
  assert.strictEqual(rowOf(db, 'b').error, 'Haiku did not answer in the asked-for format');
  assert.strictEqual(rowOf(db, 'c').error, 'Haiku gave no answer (empty-reply)');
});

test('recordReview throws on a bad session id, a missing outcome, or no claim', () => {
  const { review, db } = fixture();
  assert.throws(() => review.recordReview(db, { sessionId: '../x', reply: '{}' }, NOW), /session id/);
  review.claimReview(db, { sessionId: 'a', project: null, endedAt: 1 }, NOW);
  assert.throws(() => review.recordReview(db, { sessionId: 'a' }, NOW), /expected/);
  assert.throws(() => review.recordReview(db, { sessionId: 'never', reply: '{"suggestions":[]}' }, NOW), /no claimed review/);
});

// A review as bin/review-session leaves it: claimed, then finished.
function seed(review, db, id, fields = {}, suggestions = [], at = NOW - HOUR) {
  review.claimReview(db, { sessionId: id, project: 'demo', endedAt: fields.endedAt ?? NOW - 2 * HOUR }, at);
  if (fields.transcript !== undefined || fields.title !== undefined || fields.branch !== undefined) review.updateReview(db, id, fields);
  review.finishReview(db, id, { status: fields.status ?? 'done', suggestions, error: fields.error, reason: fields.reason }, at);
}

test('readReviews lists done and failed reviews from the last 7 days with suggestion state', () => {
  const { review, db, base } = fixture();
  seed(review, db, 'done', { endedAt: NOW - 2 * HOUR }, [{ kind: 'workflow', text: 'x' }, { kind: 'token-waste', text: 'y' }]);
  review.setDismissal(db, 'done', 1, 'not_useful', NOW);
  seed(review, db, 'failed', { endedAt: NOW - HOUR, status: 'failed', error: 'Haiku call failed (Error)' });
  seed(review, db, 'skipped', { status: 'skipped', reason: 'under 3 prompts' });
  review.claimReview(db, { sessionId: 'pending', project: 'demo', endedAt: NOW - HOUR }, NOW);
  seed(review, db, 'old', { endedAt: NOW - 8 * DAY }, [], NOW - 8 * DAY);
  assert.deepStrictEqual(review.readReviews(db, path.join(base, 'projects'), NOW), [
    { sessionId: 'failed', title: null, branch: null, transcript: null, project: 'demo', endedAt: NOW - HOUR, reviewedAt: NOW - HOUR, status: 'failed', suggestions: [], error: 'Haiku call failed (Error)' },
    { sessionId: 'done', title: null, branch: null, transcript: null, project: 'demo', endedAt: NOW - 2 * HOUR, reviewedAt: NOW - HOUR, status: 'done', suggestions: [
      { idx: 0, kind: 'workflow', text: 'x', dismissedAt: null, reason: null },
      { idx: 1, kind: 'token-waste', text: 'y', dismissedAt: NOW, reason: 'not_useful' },
    ] },
  ]);
});

test('readReviews returns an empty list for an empty database', () => {
  const { review, db, projects } = fixture();
  assert.deepStrictEqual(review.readReviews(db, projects, NOW), []);
});

test('readReviews returns the saved title and transcript, and finds the transcript of a row without one', () => {
  const { review, db, projects } = fixture();
  seed(review, db, 'saved', { transcript: '/x/saved.jsonl', title: 'Fix the chart', branch: 'feat/chart' });
  seed(review, db, 'older', {});
  writeSessionTranscript(projects, 'older', 1);
  const byId = Object.fromEntries(review.readReviews(db, projects, NOW).map((r) => [r.sessionId, r]));
  assert.deepStrictEqual([byId.saved.title, byId.saved.transcript, byId.saved.branch], ['Fix the chart', '/x/saved.jsonl', 'feat/chart']);
  assert.deepStrictEqual([byId.older.title, byId.older.transcript], [null, path.join(projects, '-work-demo', 'older.jsonl')]);
});

test('readTranscript returns the digest with the last title and branch and the first cwd and timestamp', async () => {
  const { review, base } = fixture();
  const file = path.join(base, 't.jsonl');
  const lines = [
    { type: 'ai-title', aiTitle: 'First' },
    { ...typed('hi'), gitBranch: 'main', cwd: '/work/app', timestamp: '2026-10-13T10:00:00.000Z' },
    { type: 'ai-title', aiTitle: '  Second  ' },
    { ...typed('more'), gitBranch: 'feat/x', cwd: '/work/app/sub', timestamp: '2026-10-13T11:00:00.000Z' },
    { ...typed('again'), gitBranch: '' },
    { type: 'assistant', isSidechain: true, gitBranch: 'side', message: { content: [] } },
    { type: 'ai-title', aiTitle: '   ' },
    { type: 'ai-title', aiTitle: 4 },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json "ai-title" "gitBranch" "cwd"\n5\n');
  assert.deepStrictEqual(await review.readTranscript(file), {
    prompts: 3,
    text: 'USER: hi\nUSER: more\nUSER: again',
    title: 'Second',
    branch: 'side',
    cwd: '/work/app',
    startedAt: Date.parse('2026-10-13T10:00:00.000Z'),
  });
});

test('readTranscript has null facts when no line carries them', async () => {
  const { review, base } = fixture();
  const file = path.join(base, 't.jsonl');
  fs.writeFileSync(file, JSON.stringify(typed('hi')) + '\n');
  assert.deepStrictEqual(await review.readTranscript(file), {
    prompts: 1, text: 'USER: hi', title: null, branch: null, cwd: null, startedAt: null,
  });
});

test('readTranscript returns null for a missing file', async () => {
  const { review, base } = fixture();
  assert.strictEqual(await review.readTranscript(path.join(base, 'missing.jsonl')), null);
});

test('pendingReviews saves the transcript path and title in the claim, and finishReview keeps them', async () => {
  const { review, db, sessionsDir, projects } = fixture();
  writeSnapshot(sessionsDir, { sessionId: 'big', project: 'demo', endedAt: NOW - 1 });
  writeSessionTranscript(projects, 'big', 3);
  const file = path.join(projects, '-work-demo', 'big.jsonl');
  fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Big one', sessionId: 'big' }) + '\n' + JSON.stringify({ type: 'system', sessionId: 'big', gitBranch: 'feat/big' }) + '\n');
  await review.pendingReviews({ db, sessionsDir, projects, now: NOW });
  const saved = () => rowOf(db, 'big');
  assert.deepStrictEqual([saved().transcript, saved().title, saved().branch], [file, 'Big one', 'feat/big']);
  review.recordReview(db, { sessionId: 'big', reply: '{"suggestions":[]}' }, NOW);
  assert.deepStrictEqual([saved().transcript, saved().title, saved().branch, saved().status], [file, 'Big one', 'feat/big', 'done']);
});

test('setDismissal dismisses, overwrites, undoes, and reports a suggestion that does not exist', () => {
  const { review, db } = fixture();
  seed(review, db, 'a', {}, [{ kind: 'workflow', text: 'x' }, { kind: 'token-waste', text: 'y' }]);
  seed(review, db, 'b', {}, [{ kind: 'workflow', text: 'z' }]);
  assert.strictEqual(review.setDismissal(db, 'a', 1, 'done', NOW), true);
  assert.deepStrictEqual(suggestionsOf(db, 'a').map((s) => [s.dismissed_at, s.reason]), [[null, null], [NOW, 'done']]);
  assert.strictEqual(review.setDismissal(db, 'a', 1, 'not_useful', NOW + 1), true);
  assert.deepStrictEqual(suggestionsOf(db, 'a')[1].reason, 'not_useful');
  assert.strictEqual(review.setDismissal(db, 'a', 1, null), true);
  assert.deepStrictEqual(suggestionsOf(db, 'a').map((s) => [s.dismissed_at, s.reason]), [[null, null], [null, null]]);
  assert.strictEqual(review.setDismissal(db, 'a', 2, 'done', NOW), false);
  assert.strictEqual(review.setDismissal(db, 'nope', 0, 'done', NOW), false);
  assert.deepStrictEqual(suggestionsOf(db, 'b').map((s) => s.reason), [null]);
});

test('setDismissal rejects a reason outside done and not_useful', () => {
  const { review, db } = fixture();
  seed(review, db, 'a', {}, [{ kind: 'workflow', text: 'x' }]);
  assert.throws(() => review.setDismissal(db, 'a', 0, 'bored', NOW), /reason/);
});

test('a dismissal survives readReviews and a later finishReview of another session', () => {
  const { review, db, projects } = fixture();
  seed(review, db, 'a', {}, [{ kind: 'workflow', text: 'x' }]);
  review.setDismissal(db, 'a', 0, 'done', NOW);
  seed(review, db, 'b', {}, [{ kind: 'workflow', text: 'y' }]);
  assert.strictEqual(review.readReviews(db, projects, NOW).find((r) => r.sessionId === 'a').suggestions[0].reason, 'done');
});
