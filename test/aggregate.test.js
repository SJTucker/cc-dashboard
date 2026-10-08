'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { aggregate } = require('../lib/aggregate');

// A fixed "now" in local time, so a range's cutoff does not depend on when the suite runs.
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const at = (daysBack, hour = 10) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

// A row set with nothing in it, overridden per test.
function rowSet(overrides = {}) {
  return { ok: true, calls: [], toolUses: [], errors: [], edits: [], prompts: [], sessions: {}, minT: null, maxT: null, ...overrides };
}

function call(overrides = {}) {
  return {
    key: 'm1:r1',
    t: at(0),
    sessionId: 's1',
    sidechain: false,
    model: 'claude-sonnet-4-6',
    version: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    attributionSkill: null,
    attributionAgent: null,
    tools: [],
    ...overrides,
  };
}

const run = (entries, opts = {}) => aggregate(entries, { days: null, now: NOW, ...opts });

test('a call key that appears in two entries counts once, from the first entry in walk order', () => {
  const first = rowSet({ calls: [call({ usage: { input_tokens: 100, output_tokens: 50 }, model: 'claude-sonnet-4-6' })] });
  const second = rowSet({ calls: [call({ usage: { input_tokens: 999, output_tokens: 1 } })] });
  const data = run([first, second]);

  assert.strictEqual(data.summary.apiCalls, 1);
  assert.strictEqual(data.summary.totalInput, 100);
});

test('calls with a null key are never deduped', () => {
  const entry = rowSet({ calls: [call({ key: null }), call({ key: null })] });

  assert.strictEqual(run([entry]).summary.apiCalls, 2);
});

test('a tool use key that appears in two entries counts once, with the first entry name', () => {
  const first = rowSet({ toolUses: [{ key: 'toolu_1', t: at(0), name: 'Bash', detail: 'git' }] });
  const second = rowSet({ toolUses: [{ key: 'toolu_1', t: at(0), name: 'Read', detail: null }] });
  const data = run([first, second]);

  assert.strictEqual(data.summary.toolCalls, 1);
  assert.deepStrictEqual(data.tools.map((t) => t.name), ['Bash']);
});

test('a tool error that appears in two entries keeps the last one in walk order', () => {
  const use = { toolUses: [{ key: 'toolu_1', t: at(0), name: 'Bash', detail: 'git' }] };
  const first = rowSet({ ...use, errors: [{ toolUseId: 'toolu_1', t: at(0), text: 'Exit code 1 first' }] });
  const second = rowSet({ errors: [{ toolUseId: 'toolu_1', t: at(0, 11), text: 'Exit code 2 second' }] });
  const data = run([first, second]);

  assert.strictEqual(data.summary.toolErrors, 1);
  assert.strictEqual(data.tools[0].errorGroups[0].example, 'Exit code 2 second');
});

test('an edit that appears in two entries counts once, from the first entry', () => {
  const first = rowSet({ edits: [{ toolUseId: 'toolu_1', t: at(0), sessionId: 's1', added: 3, removed: 1 }] });
  const second = rowSet({ edits: [{ toolUseId: 'toolu_1', t: at(0), sessionId: 's1', added: 50, removed: 50 }] });

  assert.deepStrictEqual(run([first, second]).efficiency.linesBySession, { s1: { added: 3, removed: 1 } });
});

test('a prompt id that appears in two entries counts once', () => {
  const first = rowSet({ prompts: [{ id: 'u1', t: at(0), sessionId: 's1' }] });
  const second = rowSet({ prompts: [{ id: 'u1', t: at(0), sessionId: 's2' }] });

  assert.deepStrictEqual(run([first, second]).efficiency.prompts, [{ t: at(0), sessionId: 's1' }]);
});

test('the cutoff applies before dedupe, so an old copy does not hide a copy inside the range', () => {
  const old = rowSet({ calls: [call({ t: at(10) })] });
  const recent = rowSet({ calls: [call({ t: at(0) })] });
  const data = run([old, recent], { days: 7 });

  assert.strictEqual(data.summary.apiCalls, 1);
});

test('a range starts at local midnight N-1 days back', () => {
  const entry = rowSet({ calls: [call({ key: 'a', t: at(6, 0) }), call({ key: 'b', t: at(7, 23) })] });

  assert.strictEqual(run([entry], { days: 7 }).summary.apiCalls, 1);
});

test('an entry whose newest row is before the cutoff adds no rows, but its session summaries still apply', () => {
  const idle = rowSet({
    calls: [call({ t: at(20) })],
    maxT: at(20),
    sessions: { s9: { branches: ['old-branch'], newestBranch: { t: at(20), branch: 'old-branch' }, title: 'Idle session', firstPrompt: 'hello', reportedCost: null } },
  });
  const data = run([idle], { days: 7 });

  assert.strictEqual(data.summary.apiCalls, 0);
  assert.deepStrictEqual(data.efficiency.titleBySession, { s9: 'Idle session' });
  assert.deepStrictEqual(data.efficiency.branchesBySession, { s9: ['old-branch'] });
  assert.deepStrictEqual(data.efficiency.branchBySession, { s9: 'old-branch' });
  assert.deepStrictEqual(data.efficiency.firstPromptBySession, { s9: 'hello' });
});

test('an error or edit row with no timestamp is inside every range', () => {
  const entry = rowSet({
    errors: [{ toolUseId: 'e1', t: null, text: 'x' }],
    edits: [{ toolUseId: 'd1', t: null, sessionId: 's1', added: 2, removed: 0 }],
  });
  const data = run([entry], { days: 7 });

  assert.strictEqual(data.summary.toolErrors, 1);
  assert.deepStrictEqual(data.efficiency.linesBySession, { s1: { added: 2, removed: 0 } });
});

const session = (overrides) => ({ branches: [], newestBranch: null, title: null, firstPrompt: null, reportedCost: null, ...overrides });

test('session summaries merge in walk order: branches append, newest branch by time, last title, first prompt', () => {
  const first = rowSet({
    sessions: { s1: session({ branches: ['main', 'feat'], newestBranch: { t: 100, branch: 'feat' }, title: 'Old title', firstPrompt: 'first' }) },
  });
  const second = rowSet({
    sessions: { s1: session({ branches: ['feat', 'fix'], newestBranch: { t: 50, branch: 'fix' }, title: 'New title', firstPrompt: 'second' }) },
  });
  const third = rowSet({ sessions: { s1: session({ branches: ['main'] }) } });
  const { efficiency } = run([first, second, third]);

  assert.deepStrictEqual(efficiency.branchesBySession.s1, ['main', 'feat', 'fix']);
  assert.strictEqual(efficiency.branchBySession.s1, 'feat');
  assert.strictEqual(efficiency.titleBySession.s1, 'New title');
  assert.strictEqual(efficiency.firstPromptBySession.s1, 'first');
});

test('reportedCost takes the highest value per session, and only on an all-time scan', () => {
  const a = rowSet({ sessions: { s1: session({ reportedCost: 2 }), s2: session({ reportedCost: 1 }) } });
  const b = rowSet({ sessions: { s1: session({ reportedCost: 3 }) } });
  const all = run([a, b]);

  assert.strictEqual(all.summary.reportedCost, 4);
  assert.strictEqual(all.summary.reportedSessions, 2);
  assert.strictEqual(all.summary.reportedSessionsOf, 2);

  const windowed = run([a, b], { days: 30 });
  assert.strictEqual(windowed.summary.reportedCost, null);
  assert.strictEqual(windowed.summary.reportedSessions, 0);
  assert.strictEqual(windowed.summary.reportedSessionsOf, null);
});

test('cost is computed from the stored usage, and day buckets run unbroken from the first day to today', () => {
  const entry = rowSet({ calls: [call({ key: 'a', t: at(3), usage: { input_tokens: 1_000_000, output_tokens: 0 } })] });
  const data = run([entry], { days: 7 });

  assert.ok(data.summary.totalCost > 0);
  assert.strictEqual(data.summary.unpricedTokens, 0);
  assert.strictEqual(data.models[0].model, 'claude-sonnet-4-6');
  assert.strictEqual(data.daily.length, 4);
});

test('meta counts entries and the entries whose read failed', () => {
  const data = aggregate([rowSet(), rowSet({ ok: false })], { days: null, now: NOW, projectsDir: '/nowhere' });

  assert.strictEqual(data.meta.scannedFiles, 2);
  assert.strictEqual(data.meta.unreadableFiles, 1);
  assert.strictEqual(data.meta.projectsDir, '/nowhere');
  assert.strictEqual(data.meta.dirExists, false);
});

test("bucket: 'hour' fills all 24 hour slots for today", () => {
  const data = aggregate([rowSet({ calls: [call({ t: at(0, 9) })] })], { days: 'today', bucket: 'hour', now: NOW });

  assert.ok(data.daily.length >= 23);
  assert.ok(data.daily.some((d) => d.date.endsWith('T09') && d.input === 100));
});

test('aggregating the same rows twice gives the same result', () => {
  const entries = [rowSet({ calls: [call()] })];

  assert.deepStrictEqual(run(entries), run(entries));
});
