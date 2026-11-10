'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseOrchestrator } = require('../lib/orchestrations/parse');
const { writeOrchestration } = require('./orchestration-fixture');
const { stepsOf, contextTokens, watchEvents } = require('../lib/transcript-index');
const { readSessions, getSessionsDir, LIVE_WINDOW_MS } = require('../lib/sessions');

// Record helpers in the shapes Claude Code writes.
let clock = 0;
function rec(obj) {
  clock += 1;
  return JSON.stringify({ sessionId: 's1', timestamp: new Date(Date.UTC(2026, 10, 10, 9, 0, clock)).toISOString(), ...obj });
}
const typed = (t) => rec({ type: 'user', message: { role: 'user', content: t } });
const use = (name, input, id) => ({ type: 'tool_use', id, name, input });
const assistant = (...blocks) => rec({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const result = (id, toolUseResult) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...(toolUseResult ? { toolUseResult } : {}) });

const PLAN = '/p/docs/superpowers/plans/2026-11-10-demo.md';
const IMAGE = '/p/docs/superpowers/images/2026-11-10-demo.md';
const workerPrompt = (n, wt = `/p/.worktrees/demo-t${n}`) => `Your worktree is ${wt}; work only there.\nRead ${IMAGE} in full, then do Task ${n} of ${PLAN}, "Parse the field".\nFiles this task touches: lib/parse.js, test/parse.test.js.\nDone when: the parse tests pass`;
function launch(id, agentId, description, prompt) {
  return [
    assistant(use('Agent', { description, subagent_type: 'general-purpose', model: 'sonnet', prompt }, id)),
    result(id, { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: 'sonnet', prompt }),
  ];
}

const orchestratorLines = () => [
  typed('orchestrate the plan'),
  assistant(use('Skill', { skill: 'orchestrate' }, 'sk')),
  assistant(use('Bash', { command: 'cd /p && wt switch --create demo --base main --no-cd' }, 'b0')),
  assistant(use('Bash', { command: 'cd /p && wt switch --create demo-t1 --base demo --no-cd' }, 'b1')),
  ...launch('ag1', 'aaa1', 'Task 1 worker', workerPrompt(1)),
];

test('detects an orchestrator from the Skill call', () => {
  assert.equal(parseOrchestrator(orchestratorLines()).isOrchestrator, true);
});

test('detects an orchestrator from the reset line', () => {
  const r = parseOrchestrator([typed(`Read ${IMAGE}. You are the orchestrator for ${PLAN}. Continue at wave 2.`), assistant({ type: 'text', text: 'ok' })]);
  assert.equal(r.isOrchestrator, true);
  assert.equal(r.imagePath, '/p/docs/superpowers/images/2026-11-10-demo.md');
  assert.equal(r.planPath, '/p/docs/superpowers/plans/2026-11-10-demo.md');
});

test('a plain session is not an orchestrator', () => {
  const r = parseOrchestrator([typed('fix the bug'), assistant(use('Skill', { skill: 'superpowers:writing-plans' }, 's'))]);
  assert.equal(r.isOrchestrator, false);
  assert.deepEqual([r.agents, r.steers, r.merges, r.finishing, r.imagePath, r.boardPath, r.branch], [[], [], [], false, null, null, null]);
});

test('reads workers from Agent calls and their results', () => {
  const r = parseOrchestrator(orchestratorLines());
  assert.equal(r.agents.length, 1);
  const [w] = r.agents;
  assert.deepEqual([w.role, w.task, w.title, w.files, w.worktree], ['worker', 1, 'Parse the field', ['lib/parse.js', 'test/parse.test.js'], '/p/.worktrees/demo-t1']);
  assert.deepEqual([w.agentId, w.description, w.doneWhen, w.line], ['aaa1', 'Task 1 worker', 'the parse tests pass', 5]);
  assert.match(w.startedAt, /^2026-11-10T09:/);
  assert.equal(r.imagePath, IMAGE);
  assert.equal(r.planPath, PLAN);
});

test('an Agent call with no result yet is skipped', () => {
  const lines = [typed('go'), assistant(use('Skill', { skill: 'orchestrate' }, 'sk')), assistant(use('Agent', { description: 'Task 1 worker', prompt: workerPrompt(1) }, 'ag1'))];
  assert.deepEqual(parseOrchestrator(lines).agents, []);
});

test('a review agent is a reviewer for its task', () => {
  const lines = [...orchestratorLines(), ...launch('ag2', 'bbb2', 'Task 1 review', 'Review the diff of demo-t1 against Task 1.'), ...launch('ag3', 'ccc3', 'Map the repo', 'Find the callers of parse.')];
  const [, rev, other] = parseOrchestrator(lines).agents;
  assert.deepEqual([rev.role, rev.task, rev.worktree, rev.files], ['reviewer', 1, null, []]);
  assert.deepEqual([other.role, other.task], ['agent', null]);
});

test('board path comes from the Monitor --board argument', () => {
  const cmd = '/clone/bin/transcript-index /c/subagents/agent-aaa1.jsonl --watch --files lib/parse.js --budget 120000 --board /b/custom.board.jsonl';
  const lines = [...orchestratorLines(), assistant(use('Monitor', { command: cmd, description: 'Task 1 worker' }, 'm1'))];
  assert.equal(parseOrchestrator(lines).boardPath, '/b/custom.board.jsonl');
});

test('board path falls back to the image path', () => {
  const r = parseOrchestrator(orchestratorLines());
  assert.match(r.boardPath, /2026-11-10-demo\.board\.jsonl$/);
  assert.equal(r.boardPath, '/p/docs/superpowers/images/2026-11-10-demo.board.jsonl');
});

test('image path comes from a Write to the images folder, not a feedback file', () => {
  const lines = [typed('go'), assistant(use('Skill', { skill: 'orchestrate' }, 'sk')),
    assistant(use('Write', { file_path: '/p/docs/superpowers/images/2026-11-10-demo.feedback.md', content: 'x' }, 'w1')),
    assistant(use('Write', { file_path: IMAGE, content: 'x' }, 'w2'))];
  assert.equal(parseOrchestrator(lines).imagePath, IMAGE);
});

test('plan branch comes from wt switch without a -tN suffix', () => {
  assert.equal(parseOrchestrator(orchestratorLines()).branch, 'demo');
});

test('plan branch falls back to a worker branch without its -tN suffix', () => {
  const lines = [typed('go'), assistant(use('Skill', { skill: 'orchestrate' }, 'sk')), assistant(use('Bash', { command: 'wt switch --create demo-t2 --base main --no-cd' }, 'b'))];
  assert.equal(parseOrchestrator(lines).branch, 'demo');
});

test('steers and merges are attributed to tasks', () => {
  const lines = [
    ...orchestratorLines(),
    assistant(use('SendMessage', { to: 'aaa1', summary: 'use the helper', message: 'Use parseField from lib/field.js.' }, 'sm1')),
    assistant(use('SendMessage', { to: 'zzz9', summary: 'not a worker', message: 'x' }, 'sm2')),
    assistant(use('Bash', { command: 'cd /p/.worktrees/demo && git merge --no-ff demo-t1 -m "merge demo-t2 work"' }, 'g1')),
    assistant(use('Bash', { command: 'wt remove demo-t1' }, 'g2')),
  ];
  const r = parseOrchestrator(lines);
  assert.deepEqual(r.steers.map((s) => [s.to, s.summary, s.line]), [['aaa1', 'use the helper', 7]]);
  assert.match(r.steers[0].at, /^2026-11-10T/);
  assert.equal(r.steers[0].source, 'orchestrator');
  assert.deepEqual(r.merges.map((m) => [m.task, m.line]), [[1, 9]]);
});

test('the dashboard steer note is a steer of that task\'s latest worker', () => {
  const note = (text) => rec({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });
  const lines = [
    ...orchestratorLines(),
    ...launch('ag1b', 'aaa1b', 'Task 1 worker', workerPrompt(1)),
    note('You steered Task 1 from the dashboard: Stop after this file\nthen report'),
    note('You steered Task 9 from the dashboard: no such task'),
    note('A meta row about something else'),
  ];
  const r = parseOrchestrator(lines);
  assert.equal(r.steers.length, 1);
  assert.deepEqual([r.steers[0].to, r.steers[0].summary, r.steers[0].source, r.steers[0].line], ['aaa1b', 'Stop after this file\nthen report', 'dashboard', 9]);
  assert.match(r.steers[0].at, /^2026-11-10T/);
});

test('git merge-base, merge-tree and merge --abort are not merges', () => {
  const lines = [
    ...orchestratorLines(),
    assistant(use('Bash', { command: 'git merge-base --is-ancestor demo-t1 demo' }, 'g1')),
    assistant(use('Bash', { command: 'git merge-tree demo demo-t1' }, 'g2')),
    assistant(use('Bash', { command: 'git merge --abort' }, 'g3')),
  ];
  assert.deepEqual(parseOrchestrator(lines).merges, []);
});

test('merges are limited to the branch derived from worker switches when no plan switch exists', () => {
  const lines = [
    typed('go'),
    assistant(use('Skill', { skill: 'orchestrate' }, 'sk')),
    assistant(use('Bash', { command: 'wt switch --create demo-t1 --base demo --no-cd' }, 'b1')),
    assistant(use('Bash', { command: 'git merge demo-t1' }, 'g1')),
    assistant(use('Bash', { command: 'git merge other-t2' }, 'g2')),
  ];
  assert.deepEqual(parseOrchestrator(lines).merges.map((m) => m.task), [1]);
});

test('merges are limited to the branch derived from a worker worktree when no switch exists', () => {
  const lines = [
    typed('go'),
    assistant(use('Skill', { skill: 'orchestrate' }, 'sk')),
    ...launch('ag1', 'aaa1', 'Task 1 worker', workerPrompt(1)),
    assistant(use('Bash', { command: 'git merge other-t3' }, 'g0')),
    assistant(use('Bash', { command: 'git merge demo-t1' }, 'g1')),
  ];
  const r = parseOrchestrator(lines);
  assert.equal(r.branch, 'demo');
  assert.deepEqual(r.merges.map((m) => m.task), [1]);
});

test('finishing is set by the finishing skill', () => {
  assert.equal(parseOrchestrator(orchestratorLines()).finishing, false);
  const lines = [...orchestratorLines(), assistant(use('Skill', { skill: 'superpowers:finishing-a-development-branch' }, 'fin'))];
  assert.equal(parseOrchestrator(lines).finishing, true);
});

test('malformed lines are skipped', () => {
  assert.equal(parseOrchestrator(['{oops', ...orchestratorLines(), '']).agents.length, 1);
});

// The fixture writer: its output has to parse, and its worker transcripts have to feed transcript-index.
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fixture-'));
}

test('the fixture writes an orchestration the parser and transcript-index can read', () => {
  const cfg = tmpDir();
  const out = writeOrchestration(cfg, {
    topic: 'demo',
    sessionId: 'sess-1',
    live: true,
    workers: [
      { task: 1, title: 'Parse the field', files: ['lib/parse.js'], steps: [{ tool: 'Edit', file_path: 'lib/parse.js' }, { tool: 'Bash', command: 'node --test' }], finished: true },
      { task: 2, title: 'Render it', files: ['public/a.mjs'], steps: [{ tool: 'Edit', file_path: 'public/a.mjs' }] },
    ],
    board: [{ t: '2026-11-10T09:00:00.000Z', from: 'Task 1', title: 'Field is a string', body: 'Not a number.' }],
  });
  const r = parseOrchestrator(fs.readFileSync(out.transcript, 'utf8').split('\n').filter(Boolean));
  assert.equal(r.isOrchestrator, true);
  assert.equal(r.imagePath, out.imagePath);
  assert.equal(r.boardPath, out.boardPath);
  assert.equal(r.branch, 'demo');
  assert.deepEqual(r.agents.map((a) => [a.agentId, a.role, a.task]), [[out.workerIds[0], 'worker', 1], [out.workerIds[1], 'worker', 2]]);
  assert.ok(fs.readFileSync(out.imagePath, 'utf8').length > 0);
  assert.equal(fs.readFileSync(out.boardPath, 'utf8').trim().split('\n').length, 1);

  const wfile = path.join(path.dirname(out.transcript), 'sess-1', 'subagents', `agent-${out.workerIds[0]}.jsonl`);
  const wlines = fs.readFileSync(wfile, 'utf8').split('\n').filter(Boolean);
  const steps = stepsOf(wlines, 1, wlines.length);
  assert.ok(steps.some((s) => s.kind === 'tool' && s.tool === 'Edit' && s.text.endsWith('/.worktrees/demo-t1/lib/parse.js')));
  assert.ok(contextTokens(wlines) > 0);
  const meta = JSON.parse(fs.readFileSync(wfile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  assert.equal(meta.finished, true);
  assert.equal(meta.description, 'Task 1 worker');
  const meta2 = JSON.parse(fs.readFileSync(path.join(path.dirname(wfile), `agent-${out.workerIds[1]}.meta.json`), 'utf8'));
  assert.equal(meta2.finished, undefined);

  const [snap] = readSessions(getSessionsDir(cfg));
  assert.equal(snap.sessionId, 'sess-1');
  assert.equal(snap.endedAt, undefined);
});

test('the fixture writes clearedFrom, an ended snapshot and a reset line as the first prompt', () => {
  const cfg = tmpDir();
  const out = writeOrchestration(cfg, { topic: 'demo', sessionId: 'sess-2', clearedFrom: 'sess-1', resetLine: true, workers: [] });
  const [snap] = readSessions(getSessionsDir(cfg));
  assert.equal(snap.clearedFrom, 'sess-1');
  assert.equal(typeof snap.endedAt, 'number');
  const r = parseOrchestrator(fs.readFileSync(out.transcript, 'utf8').split('\n').filter(Boolean));
  assert.equal(r.isOrchestrator, true);
  assert.equal(r.imagePath, out.imagePath);
});

test('watchEvents reports a finished fixture worker as done with its report, and a running one as not done', () => {
  const cfg = tmpDir();
  const out = writeOrchestration(cfg, {
    topic: 'demo',
    sessionId: 'sess-w',
    workers: [
      { task: 1, title: 'Parse the field', files: ['lib/parse.js'], steps: [{ tool: 'Edit', file_path: 'lib/parse.js' }], finished: true },
      { task: 2, title: 'Render it', files: ['public/a.mjs'], steps: [{ tool: 'Edit', file_path: 'public/a.mjs' }] },
    ],
  });
  const read = (id) => fs.readFileSync(path.join(path.dirname(out.transcript), 'sess-w', 'subagents', `agent-${id}.jsonl`), 'utf8').split('\n').filter(Boolean);
  const watch = (lines, finished) => {
    const opts = { files: undefined, budget: 120000, finished };
    const first = watchEvents(lines, null, opts);
    return watchEvents(lines, first.seen, opts);
  };
  const done = watch(read(out.workerIds[0]), true);
  assert.equal(done.done, true);
  assert.ok(done.events.some((e) => /^DONE Task 1 done: Parse the field/.test(e)), done.events.join('|'));
  const running = watch(read(out.workerIds[1]), false);
  assert.equal(running.done, false);
  assert.ok(!running.events.some((e) => e.startsWith('DONE')));
});

test('a live fixture snapshot counts as live by the sessions rule', () => {
  const cfg = tmpDir();
  writeOrchestration(cfg, { topic: 'demo', sessionId: 'sess-live', live: true, workers: [] });
  const [s] = readSessions(getSessionsDir(cfg));
  assert.equal(typeof s.endedAt, 'undefined');
  assert.ok(Date.now() - s.lastActiveAt <= LIVE_WINDOW_MS);
});
