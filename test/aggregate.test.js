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

// A tool use row as extractFile writes it.
const toolUse = (key, name, detail, t = at(0)) => ({ key, t, name, detail });

test('skill and subagent rows count their Skill and Agent tool calls in the range', () => {
  const entry = rowSet({
    calls: [
      call({ key: 'm1:r1', attributionSkill: 'tdd' }),
      call({ key: 'm2:r2', sidechain: true, attributionAgent: 'Explore' }),
    ],
    toolUses: [
      toolUse('toolu_1', 'Skill', 'tdd'),
      toolUse('toolu_2', 'Skill', 'tdd'),
      toolUse('toolu_3', 'Agent', 'Explore'),
      toolUse('toolu_4', 'Skill', 'tdd', at(40)), // before the 30-day range
      toolUse('toolu_5', 'Skill', null), // a Skill call with no skill input names no row
      toolUse('toolu_6', 'Bash', 'git'),
    ],
  });
  const data = run([entry], { days: 30 });

  assert.deepStrictEqual(data.skills.map((r) => [r.name, r.invocations]), [['tdd', 2]]);
  assert.deepStrictEqual(data.subagents.map((r) => [r.name, r.invocations]), [['Explore', 1]]);
});

test('a Skill call copied into a second row set counts once', () => {
  const first = rowSet({ calls: [call({ attributionSkill: 'tdd' })], toolUses: [toolUse('toolu_1', 'Skill', 'tdd')] });
  const copy = rowSet({ toolUses: [toolUse('toolu_1', 'Skill', 'tdd')] });

  assert.strictEqual(run([first, copy]).skills[0].invocations, 1);
});

test('an Agent call with no subagent_type counts toward general-purpose', () => {
  const entry = rowSet({
    calls: [call({ sidechain: true, attributionAgent: 'general-purpose' })],
    toolUses: [toolUse('toolu_1', 'Agent', null), toolUse('toolu_2', 'Agent', 'general-purpose')],
  });

  assert.deepStrictEqual(run([entry]).subagents.map((r) => [r.name, r.invocations]), [['general-purpose', 2]]);
});

test('a skill with cost and no call in the range shows 0, and a called skill with no cost has no row', () => {
  const entry = rowSet({
    calls: [call({ attributionSkill: 'review' })],
    toolUses: [toolUse('toolu_1', 'Skill', 'review', at(2)), toolUse('toolu_2', 'Skill', 'unused')],
  });
  const data = run([entry], { days: 'today' });

  assert.deepStrictEqual(data.skills.map((r) => [r.name, r.invocations]), [['review', 0]]);
});

// A command row as extractFile writes it.
const command = (id, name, t = at(0)) => ({ id, t, name });

test('a slash command adds to its skill invocations and counts once across row sets, and a built-in joins no row', () => {
  const first = rowSet({
    calls: [call({ attributionSkill: 'handoff' })],
    toolUses: [toolUse('toolu_1', 'Skill', 'handoff')],
    commands: [command('u1', 'handoff'), command('u2', 'clear'), command('u3', 'handoff', at(40))],
  });
  const copy = rowSet({ commands: [command('u1', 'handoff')] });
  const data = run([first, copy], { days: 30 });

  assert.deepStrictEqual(data.skills.map((r) => [r.name, r.invocations]), [['handoff', 2]]);
});

test('a row set with no commands field, as stored before EXTRACT_VERSION 2, counts no slash commands', () => {
  // rowSet has no commands key, like the stored rows of a transcript Claude Code deleted.
  const entry = rowSet({ calls: [call({ attributionSkill: 'tdd' })], toolUses: [toolUse('toolu_1', 'Skill', 'tdd')] });

  assert.strictEqual(run([entry]).skills[0].invocations, 1);
});

const { ERROR_CAUSES } = require('../lib/aggregate');

function causeOf(text) {
  const entry = rowSet({
    toolUses: [{ key: 'toolu_1', t: at(0), name: 'Bash', detail: 'cat', model: 'claude-opus-5-5' }],
    errors: [{ toolUseId: 'toolu_1', t: at(0), text }],
  });
  return run([entry]).tools[0].errorCauses[0].cause;
}

test('a PreToolUse hook error is blocked by a hook, not other', () => {
  assert.strictEqual(causeOf('PreToolUse:Bash hook error: Use the Read tool to read files under frontend/'), 'blocked by a hook');
});

test('a hook message that quotes an exit code is still blocked by a hook', () => {
  assert.strictEqual(causeOf('PreToolUse:Bash hook error: Exit code 2 from guard'), 'blocked by a hook');
});

test('"doesn\'t want to take this action" is rejected by you', () => {
  assert.strictEqual(causeOf("The user doesn't want to take this action right now. STOP what you are doing"), 'rejected by you');
});

test('the newly recognised misuse messages are tool misused', () => {
  for (const text of [
    'Error: No such tool available: bash. Tool names are case-sensitive: call Bash instead.',
    'File has been modified since read, either by the user or by a linter.',
    'File content (30000 tokens) exceeds maximum allowed tokens (25000).',
    'No changes to make: old_string and new_string are exactly the same.',
    'Missing required parameter: task_id',
  ]) assert.strictEqual(causeOf(text), 'tool misused', text);
});

test('an environment failure stays other', () => {
  assert.strictEqual(causeOf('connect ECONNREFUSED 127.0.0.1:443'), 'other');
});

test('ERROR_CAUSES names the six causes in match order', () => {
  assert.deepStrictEqual(ERROR_CAUSES.map(([cause]) => cause), [
    'blocked by the worktree check',
    'blocked by auto mode',
    'blocked by a hook',
    'rejected by you',
    'command failed',
    'tool misused',
  ]);
});
