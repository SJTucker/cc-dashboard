'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { readActivity } = require('../lib/activity');
const { readAgentSteps } = require('../lib/agent-steps');
const { collectMarkers } = require('../lib/changes');

// The mod test runner refuses to import a .json file, so the entries live in
// register.test.ts between two marker comments, as strict JSON.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'mod', 'hooks', 'register.test.ts'), 'utf8');
const CONTRACT = (() => {
  const where = 'contract block between contract:begin and contract:end in mod/hooks/register.test.ts';
  const begun = SOURCE.split('// contract:begin\n')[1];
  if (begun === undefined || !begun.includes('// contract:end')) throw new Error(`${where} is missing a marker`);
  const block = begun.split('// contract:end')[0];
  try {
    return JSON.parse(block.replace(/^const CONTRACT = /, ''));
  } catch (err) {
    throw new Error(`${where} is not strict JSON: ${err.message}`);
  }
})();
const CALLS = CONTRACT.calls;
const PRINTS_JSON = new Set(['judge-updates', 'review-session', 'cache-state']);
const PRINTS_NOTHING = new Set(['record-statusline', 'record-session-end']);

const typed = (text) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });

// A config dir with one ended session ("abc") that has three typed prompts, so
// `review-session prompt` claims it and `review-session record` has something to finish.
function fixture(t) {
  const base = tmpDir(t, 'mod-contract');
  const sessions = path.join(base, 'cc-dashboard', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'abc.json'), JSON.stringify({ sessionId: 'abc', project: 'demo', endedAt: Date.now() }));
  fs.mkdirSync(path.join(base, 'projects', '-work-demo'), { recursive: true });
  fs.writeFileSync(path.join(base, 'projects', '-work-demo', 'abc.jsonl'), ['one', 'two', 'three'].map(typed).join('\n') + '\n');
  return base;
}

test('every call in the contract block of mod/hooks/register.test.ts runs against the real script', (t) => {
  const base = fixture(t);
  assert.ok(CALLS.length >= 6, 'the contract block lists the mod calls');
  for (const call of CALLS) {
    const label = `${call.script} ${call.args.join(' ')}`.trim();
    const input = typeof call.stdin === 'string' ? call.stdin : JSON.stringify(call.stdin);
    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', call.script), ...call.args], {
      input,
      env: { ...process.env, HOME: base, CLAUDE_CONFIG_DIR: base, CHANGES_FILE: path.join(base, 'changes.json'), RTK_DB: path.join(base, 'rtk.db') },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.strictEqual(res.status, 0, `${label} exited ${res.status}: ${res.stderr}`);
    if (PRINTS_JSON.has(call.script)) {
      assert.doesNotThrow(() => JSON.parse(res.stdout), `${label} printed JSON, got ${JSON.stringify(res.stdout)}`);
    }
    if (PRINTS_NOTHING.has(call.script)) {
      assert.strictEqual(res.stdout, '', `${label} must print nothing, because its stdout is the statusline`);
    }
  }
});

test('readActivity parses the activity sample the mod writes', (t) => {
  const dir = tmpDir(t, 'contract-activity');
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify(CONTRACT.activity));
  const a = CONTRACT.activity;
  assert.deepStrictEqual(readActivity(dir, a.updatedAt + 1000).get('s1'), {
    sessionId: a.sessionId, state: a.state, since: a.since, tool: null, subagents: 0, updatedAt: a.updatedAt,
  });
});

test('readAgentSteps parses the agent usage sample the mod writes', async (t) => {
  const file = path.join(tmpDir(t, 'contract-agent'), `${CONTRACT.agentUsage.agentId}.json`);
  fs.writeFileSync(file, JSON.stringify(CONTRACT.agentUsage));
  const rows = await readAgentSteps(file);
  assert.strictEqual(rows.ok, true);
  const { t: time, model, input, cacheWrite, cacheRead, output } = CONTRACT.agentUsage.steps[0];
  assert.deepStrictEqual(rows.agentSteps, [{ agentId: 'a1', t: time, model, input, cacheWrite, cacheRead, output }]);
});

test('collectMarkers turns the changes sample the mod writes into one auto marker', (t) => {
  const base = tmpDir(t, 'contract-changes');
  const dir = path.join(base, 'cc-dashboard', 'changes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.json'), `${JSON.stringify(CONTRACT.changes, null, 2)}\n`);
  const [entry] = CONTRACT.changes;
  const week = 7 * 24 * 60 * 60 * 1000;
  // One call a week before the entry, so the marker has the history a marker needs.
  const calls = [{ t: entry.t - week, model: 'm', version: '2.1.290' }];
  const { markers } = collectMarkers(calls, { configDir: base, changesFile: path.join(base, 'none.json') });
  assert.deepStrictEqual(markers, [{ t: entry.t, kind: entry.kind, label: `${entry.name}: ${entry.label}`, source: 'auto' }]);
});

test('each reader skips a truncated copy of its sample without throwing', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const base = tmpDir(t, 'contract-truncated');
  const cut = (value) => JSON.stringify(value).slice(0, 25);
  const activityDir = path.join(base, 'activity');
  fs.mkdirSync(activityDir);
  fs.writeFileSync(path.join(activityDir, 's1.json'), cut(CONTRACT.activity));
  assert.strictEqual(readActivity(activityDir, CONTRACT.activity.updatedAt).size, 0);
  const agentFile = path.join(base, 'a1.json');
  fs.writeFileSync(agentFile, cut(CONTRACT.agentUsage));
  assert.strictEqual((await readAgentSteps(agentFile)).ok, false);
  const changesDir = path.join(base, 'cc-dashboard', 'changes');
  fs.mkdirSync(changesDir, { recursive: true });
  fs.writeFileSync(path.join(changesDir, 's1.json'), cut(CONTRACT.changes));
  const { markers } = collectMarkers([{ t: CONTRACT.changes[0].t - 7 * 24 * 60 * 60 * 1000, model: 'm' }], { configDir: base, changesFile: path.join(base, 'none.json') });
  assert.deepStrictEqual(markers, []);
});
