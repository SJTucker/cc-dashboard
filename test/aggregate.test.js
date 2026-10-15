'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { aggregate } = require('../lib/aggregate');
const { outputRate, costForUsage } = require('../lib/pricing');

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
  return { ok: true, calls: [], toolUses: [], errors: [], edits: [], prompts: [], commands: [], sessions: {}, minT: null, maxT: null, ...overrides };
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

test('recapBySession takes the recap of the last row set that has one, in walk order', () => {
  const rows = (recap) => rowSet({ sessions: { s1: session(recap === undefined ? {} : { recap }) } });
  const { efficiency } = run([rows('Old'), rows('New'), rows(undefined), rows(null)]);
  assert.deepStrictEqual(efficiency.recapBySession, { s1: 'New' });
});

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
  assert.deepStrictEqual(efficiency.recapBySession, {}, 'rows without recap leave the map empty');
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

const use = (key, model, name = 'Bash', t = at(0)) => ({ key, t, name, detail: null, model });
const err = (toolUseId, text) => ({ toolUseId, t: at(0), text });

test('byModel counts calls and causes per model label, for a tool and for toolTotals', () => {
  const entry = rowSet({
    toolUses: [use('a', 'claude-opus-5-5'), use('b', 'claude-opus-5-5'), use('c', 'claude-sonnet-5-5'), use('d', 'claude-sonnet-5-5', 'Edit')],
    errors: [err('a', 'Exit code 1'), err('c', 'Error: No such tool available: bash'), err('d', 'String to replace not found in file.')],
  });
  const data = run([entry]);

  assert.deepStrictEqual(data.tools.find((t) => t.name === 'Bash').byModel, [
    { label: 'Opus 5.5', family: 'opus', calls: 2, errors: 1, errorCauses: [{ cause: 'command failed', count: 1 }] },
    { label: 'Sonnet 5.5', family: 'sonnet', calls: 1, errors: 1, errorCauses: [{ cause: 'tool misused', count: 1 }] },
  ]);
  assert.strictEqual(data.toolTotals.name, 'All tools');
  assert.strictEqual(data.toolTotals.calls, 4);
  assert.deepStrictEqual(data.toolTotals.details, []);
  assert.deepStrictEqual(data.toolTotals.byModel.map((m) => [m.label, m.calls, m.errors]), [['Opus 5.5', 2, 1], ['Sonnet 5.5', 2, 2]]);
  assert.deepStrictEqual(data.toolTotals.errorCauses, [{ cause: 'tool misused', count: 2 }, { cause: 'command failed', count: 1 }]);
});

test('two model ids with one label share one byModel row', () => {
  const entry = rowSet({ toolUses: [use('a', 'claude-opus-5'), use('b', 'claude-opus-5-20260101')] });

  assert.deepStrictEqual(run([entry]).tools[0].byModel.map((m) => [m.label, m.calls]), [['Opus 5', 2]]);
});

test('a tool use with a null model is under Unknown model', () => {
  const entry = rowSet({ toolUses: [use('a', null)] });

  assert.deepStrictEqual(run([entry]).tools[0].byModel.map((m) => [m.label, m.family]), [['Unknown model', 'other']]);
});

test('toolTotals counts only errors whose tool use is in range, as the tools do', () => {
  const entry = rowSet({
    toolUses: [use('a', 'claude-opus-5-5', 'Bash', at(10)), use('b', 'claude-opus-5-5', 'Bash', at(0))],
    errors: [err('a', 'Exit code 1'), err('b', 'Exit code 1')],
  });
  const data = run([entry], { days: 7 });

  assert.strictEqual(data.summary.toolErrors, 2, 'summary counts the error of the use before the cutoff');
  assert.strictEqual(data.toolTotals.errors, data.tools.reduce((n, t) => n + t.errors, 0));
  assert.strictEqual(data.toolTotals.errors, 1);
});

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const rebuilt = (overrides = {}) => call({
  model: 'claude-opus-5-5',
  usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 } },
  rebuild: { cause: 'expired', reason: null, tokens: 100_000, gapMs: 600_000 },
  ...overrides,
});

// Opus 5.5 in lib/pricing.js: input $4/M, 5m write 1.25x, 1h write 2x, read 0.05x.
test('a rebuild\'s premium is its cost minus the cost of reading the same tokens from cache', () => {
  const data = run([rowSet({ calls: [rebuilt()] })]);
  const [rec] = data.efficiency.calls;
  assert.deepStrictEqual({ ...rec.rebuild, premium: round6(rec.rebuild.premium) }, {
    cause: 'expired', reason: null, tokens: 100_000, gapMs: 600_000, premium: 0.48,
  });
});

test('a 1-hour rebuild\'s premium uses the 1-hour write price', () => {
  const usage = { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 } };
  const data = run([rowSet({ calls: [rebuilt({ usage })] })]);
  assert.strictEqual(round6(data.efficiency.calls[0].rebuild.premium), 0.78);
});

test('an unpriced model\'s rebuild has a null premium', () => {
  const data = run([rowSet({ calls: [rebuilt({ model: 'claude-unknown-9' })] })]);
  assert.strictEqual(data.efficiency.calls[0].rebuild.premium, null);
});

test('a call without rebuild gets no rebuild field', () => {
  const data = run([rowSet({ calls: [call()] })]);
  assert.strictEqual('rebuild' in data.efficiency.calls[0], false);
});

test('a call record carries its 5-minute and 1-hour cache write tokens', () => {
  const usage = { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } };
  const [rec] = run([rowSet({ calls: [call({ model: 'claude-opus-5-5', usage })] })]).efficiency.calls;
  assert.strictEqual(rec.write5m, 100);
  assert.strictEqual(rec.write1h, 200);
});

test('a call with only the flat cache write total counts it as 5-minute writes', () => {
  const usage = { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 0 };
  const [rec] = run([rowSet({ calls: [call({ model: 'claude-opus-5-5', usage })] })]).efficiency.calls;
  assert.strictEqual(rec.write5m, 300);
  assert.strictEqual(rec.write1h, 0);
});

const thinkingUsage = (output, thinking, more = {}) => ({ input_tokens: 0, output_tokens: output, output_tokens_details: { thinking_tokens: thinking }, ...more });
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

test('thinking sums count only calls that report thinking_tokens, a 0 included', () => {
  const entry = rowSet({
    calls: [
      call({ key: 'a', usage: thinkingUsage(100, 40) }),
      call({ key: 'b', usage: thinkingUsage(60, 0) }),
      call({ key: 'c', usage: { input_tokens: 0, output_tokens: 500 } }),
    ],
  });
  const data = run([entry]);
  const s = data.summary;

  assert.strictEqual(s.thinking, 40);
  assert.strictEqual(s.thinkingOutput, 160);
  assert.strictEqual(s.thinkingCalls, 2);
  assert.strictEqual(s.apiCalls, 3);
  close(s.thinkingCost, 40 * outputRate({}, 'claude-sonnet-4-6', at(0)), 'thinking cost at the output rate');

  const day = data.daily.find((d) => d.thinkingOutput > 0);
  assert.strictEqual(day.thinking, 40);
  assert.strictEqual(day.thinkingOutput, 160);
  close(day.thinkingCost, s.thinkingCost, 'day thinking cost');

  const model = data.models.find((m) => m.model === 'claude-sonnet-4-6');
  assert.strictEqual(model.thinking, 40);
  assert.strictEqual(model.thinkingOutput, 160);
  close(model.thinkingCost, s.thinkingCost, 'model thinking cost');

  assert.deepStrictEqual(data.efficiency.calls.map((c) => c.thinking), [40, 0, null]);
});

test('thinking cost uses the fast output rate for a fast call', () => {
  const entry = rowSet({
    calls: [
      call({ key: 'std', model: 'claude-opus-5', usage: thinkingUsage(2_000_000, 1_000_000) }),
      call({ key: 'fast', model: 'claude-opus-5', usage: thinkingUsage(2_000_000, 1_000_000, { speed: 'fast' }) }),
    ],
  });
  close(run([entry]).summary.thinkingCost, 25 + 50, 'Opus 5: 1M thinking at $25 standard plus 1M at $50 fast');
});

test('an unpriced model adds thinking tokens but no thinking cost', () => {
  const data = run([rowSet({ calls: [call({ model: 'some-unknown-model', usage: thinkingUsage(30, 10) })] })]);

  assert.strictEqual(data.summary.thinking, 10);
  assert.strictEqual(data.summary.thinkingCost, 0);
  assert.strictEqual(data.models[0].thinking, 10);
  assert.strictEqual(data.models[0].thinkingCost, 0);
});

test('a call copied into two row sets adds its thinking once', () => {
  const copy = () => rowSet({ calls: [call({ key: 'same', usage: thinkingUsage(100, 40) })] });
  const s = run([copy(), copy()]).summary;

  assert.strictEqual(s.thinking, 40);
  assert.strictEqual(s.thinkingCalls, 1);
});

test('a range with no calls has zero thinking sums, and empty hour slots carry the fields', () => {
  assert.deepStrictEqual(
    (({ thinking, thinkingOutput, thinkingCost, thinkingCalls }) => ({ thinking, thinkingOutput, thinkingCost, thinkingCalls }))(run([rowSet()]).summary),
    { thinking: 0, thinkingOutput: 0, thinkingCost: 0, thinkingCalls: 0 },
  );
  const hourly = aggregate([rowSet({ calls: [call({ t: at(0, 9), usage: thinkingUsage(100, 40) })] })], { days: 'today', bucket: 'hour', now: NOW });
  for (const slot of hourly.daily) {
    assert.strictEqual(typeof slot.thinking, 'number', slot.date);
    assert.strictEqual(typeof slot.thinkingOutput, 'number', slot.date);
    assert.strictEqual(typeof slot.thinkingCost, 'number', slot.date);
  }
  assert.strictEqual(hourly.daily.find((d) => d.date.endsWith('T09')).thinking, 40);
});

const stepRows = (steps, over = {}) => ({ ...rowSet(), agentSteps: steps, ...over });
const NF_USAGE = { input_tokens: 2, output_tokens: 8, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
const STEP_A1 = { agentId: 'a1', t: at(0), model: 'claude-sonnet-4-6', input: 2, cacheWrite: 10, cacheRead: 20, output: 500 };
const noFinalCall = (over = {}) => call({ key: 'nf', sidechain: true, agentId: 'a1', noFinal: true, usage: NF_USAGE, ...over });

test('a no-final subagent call with a matching step is priced at the recorded output everywhere', () => {
  const data = run([rowSet({ calls: [noFinalCall()] }), stepRows([STEP_A1])]);
  const expected = costForUsage({ ...NF_USAGE, output_tokens: 500 }, 'claude-sonnet-4-6', at(0)).cost;

  assert.strictEqual(data.summary.totalOutput, 500);
  assert.ok(Math.abs(data.summary.totalCost - expected) < 1e-12);
  assert.ok(Math.abs(data.threads.subagent - expected) < 1e-12);
  assert.strictEqual(data.daily.find((d) => d.output > 0).output, 500);
  assert.ok(Math.abs(data.models[0].cost - expected) < 1e-12);
  assert.strictEqual(data.efficiency.calls[0].output, 500);
  assert.deepStrictEqual([data.meta.noFinalCalls, data.meta.noFinalCorrected], [1, 1]);
});

test('the step file may come before the transcript in walk order', () => {
  const data = run([stepRows([STEP_A1]), rowSet({ calls: [noFinalCall()] })]);
  assert.strictEqual(data.summary.totalOutput, 500);
});

test('a no-final call with no matching step keeps its own output and is counted', () => {
  const data = run([rowSet({ calls: [noFinalCall()] }), stepRows([{ ...STEP_A1, cacheRead: 21 }])]);
  assert.strictEqual(data.summary.totalOutput, 8);
  assert.deepStrictEqual([data.meta.noFinalCalls, data.meta.noFinalCorrected], [1, 0]);
});

test('a call with a final line is never changed by a step', () => {
  const finished = call({ key: 'f', sidechain: true, agentId: 'a1', usage: NF_USAGE });
  const data = run([rowSet({ calls: [finished] }), stepRows([STEP_A1])]);
  assert.strictEqual(data.summary.totalOutput, 8);
  assert.deepStrictEqual([data.meta.noFinalCalls, data.meta.noFinalCorrected], [0, 0]);
});

test('a recorded output no larger than the transcript\'s is not used', () => {
  const data = run([rowSet({ calls: [noFinalCall()] }), stepRows([{ ...STEP_A1, output: 8 }])]);
  assert.strictEqual(data.summary.totalOutput, 8);
  assert.strictEqual(data.meta.noFinalCorrected, 0);
});

test('a no-final call with no agentId is left as it is and not counted', () => {
  const data = run([rowSet({ calls: [noFinalCall({ agentId: undefined })] }), stepRows([STEP_A1])]);
  assert.strictEqual(data.summary.totalOutput, 8);
  assert.strictEqual(data.meta.noFinalCalls, 0);
});

test('scannedFiles and unreadableFiles count transcripts only, not step files', () => {
  const data = run([rowSet(), stepRows([STEP_A1]), stepRows([], { ok: false })]);
  assert.strictEqual(data.meta.scannedFiles, 1);
  assert.strictEqual(data.meta.unreadableFiles, 0);
});

test('cacheCost parts sum to totalCost over main, subagent and unpriced calls', () => {
  const u = (extra) => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, ...extra });
  const out = run([rowSet({ calls: [
    call({ key: 'a', usage: u() }),
    call({ key: 'b', sidechain: true, usage: u({ output_tokens: 900 }) }),
    call({ key: 'c', model: 'mystery-model', usage: u() }),
    call({ key: 'd', model: 'claude-opus-5', usage: u({ speed: 'fast' }) }),
  ] })]);
  const { cacheRead, cacheWrite, input, output, saved } = out.cacheCost;
  assert.ok(cacheRead > 0 && cacheWrite > 0 && input > 0 && output > 0 && saved > 0);
  close(cacheRead + cacheWrite + input + output, out.summary.totalCost, 'cacheCost sums to totalCost');
});

test('contextFillers counts a result copied into a resumed session once', () => {
  const toolUses = [{ key: 'toolu_1', t: at(0), name: 'Bash', detail: 'sed', model: null, group: 'sed -n' }];
  const results = [{ toolUseId: 'toolu_1', t: at(0), sessionId: 's1', chars: 40 }];
  const data = run([rowSet({ toolUses, results }), rowSet({ toolUses, results })]);
  assert.deepStrictEqual(data.contextFillers.rows.map((r) => [r.group, r.calls, r.chars]), [['sed -n', 1, 40]]);
});

test('contextFillers takes the group from a later copy when the first copy has none', () => {
  const use = { key: 'toolu_1', t: at(0), name: 'Bash', detail: 'sed', model: null };
  const results = [{ toolUseId: 'toolu_1', t: at(0), sessionId: 's1', chars: 40 }];
  const data = run([rowSet({ toolUses: [use], results }), rowSet({ toolUses: [{ ...use, group: 'sed -n' }], results })]);
  assert.strictEqual(data.contextFillers.rows[0].group, 'sed -n');
});

test('contextFillers leaves out results before the range', () => {
  const toolUses = [{ key: 'toolu_1', t: at(10), name: 'Read', detail: '/a', model: null }];
  const results = [{ toolUseId: 'toolu_1', t: at(10), sessionId: 's1', chars: 40 }];
  const data = run([rowSet({ toolUses, results, maxT: at(10) })], { days: 7 });
  assert.deepStrictEqual(data.contextFillers.rows, []);
});

test('a turn copied into a resumed session counts once, and efficiency.turns is sorted by time', () => {
  const turns = [
    { id: 'td2', t: at(0, 11), sessionId: 's1', durationMs: 5000 },
    { id: 'td1', t: at(0, 10), sessionId: 's1', durationMs: 9000 },
  ];
  const data = run([rowSet({ turns }), rowSet({ turns })]);
  assert.deepStrictEqual(data.efficiency.turns, [
    { t: at(0, 10), sessionId: 's1', durationMs: 9000 },
    { t: at(0, 11), sessionId: 's1', durationMs: 5000 },
  ]);
  assert.deepStrictEqual(data.longestTurns.map((x) => x.durationMs), [9000, 5000]);
});
