'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseOrchestrator } = require('../lib/orchestrations/parse');
const { writeOrchestration } = require('./orchestration-fixture');
const { tmpDir } = require('./helpers');
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
  const cmd = '/clone/bin/transcript-index /c/subagents/agent-aaa1.jsonl --watch --files lib/parse.js --budget 200000 --board /b/custom.board.jsonl';
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

const monitor = (command, id = 'mon') => assistant(use('Monitor', { command, description: 'watch' }, id));
const boardOf = (command) => parseOrchestrator([...orchestratorLines(), monitor(command)]).boardPath;
const IMAGE_BOARD = '/p/docs/superpowers/images/2026-11-10-demo.board.jsonl';

test('--board accepts an unquoted path, and a quoted path with spaces', () => {
  assert.equal(boardOf('bin/transcript-index f --watch --board /p/a/x.board.jsonl'), '/p/a/x.board.jsonl');
  assert.equal(boardOf('bin/transcript-index f --watch --board "/p/my dir/x.board.jsonl" --budget 1'), '/p/my dir/x.board.jsonl');
  assert.equal(boardOf("bin/transcript-index f --watch --board '/p/my dir/x.board.jsonl'"), '/p/my dir/x.board.jsonl');
});

test('--board that does not end in .board.jsonl is ignored for the image-derived path', () => {
  assert.equal(boardOf('bin/transcript-index f --board /p/notes.txt'), IMAGE_BOARD);
  assert.equal(boardOf('bin/transcript-index f --board "/p/my dir/notes.txt"'), IMAGE_BOARD);
});

test('a files line that ends the prompt still yields its files', () => {
  const prompt = `Your worktree is /p/.worktrees/demo-t1; work only there.\nRead ${IMAGE} in full, then do Task 1 of ${PLAN}, "T".\nFiles this task touches: lib/a.js, lib/b.js.`;
  const r = parseOrchestrator([typed('go'), assistant(use('Skill', { skill: 'orchestrate' }, 'sk')), ...launch('ag1', 'aaa1', 'Task 1 worker', prompt)]);
  assert.deepEqual(r.agents[0].files, ['lib/a.js', 'lib/b.js']);
});

const metaNote = (text) => rec({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });

test('the "a worker" steer note is read back, and stays out of steers', () => {
  const r = parseOrchestrator([...orchestratorLines(), metaNote('You steered a worker from the dashboard: check the tests')]);
  assert.deepEqual(r.notes.map((n) => [n.task, n.summary, n.line]), [[null, 'check the tests', 7]]);
  assert.deepEqual(r.steers, []);
});

test('a note for a task with no worker is kept in notes and left out of steers', () => {
  const r = parseOrchestrator([...orchestratorLines(), metaNote('You steered Task 9 from the dashboard: nobody home')]);
  assert.deepEqual(r.notes.map((n) => [n.task, n.summary]), [[9, 'nobody home']]);
  assert.deepEqual(r.unmappedNotes.map((n) => n.task), [9]);
  assert.deepEqual(r.steers, []);
});

test('a note that maps to a worker is in notes and steers, and is not unmapped', () => {
  const r = parseOrchestrator([...orchestratorLines(), metaNote('You steered Task 1 from the dashboard: go')]);
  assert.equal(r.notes.length, 1);
  assert.deepEqual(r.unmappedNotes, []);
  assert.deepEqual(r.steers.map((s) => [s.to, s.source]), [['aaa1', 'dashboard']]);
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

test('the fixture writes an orchestration the parser and transcript-index can read', (t) => {
  const cfg = tmpDir(t, 'fixture');
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

test('the fixture writes clearedFrom, an ended snapshot and a reset line as the first prompt', (t) => {
  const cfg = tmpDir(t, 'fixture');
  const out = writeOrchestration(cfg, { topic: 'demo', sessionId: 'sess-2', clearedFrom: 'sess-1', resetLine: true, workers: [] });
  const [snap] = readSessions(getSessionsDir(cfg));
  assert.equal(snap.clearedFrom, 'sess-1');
  assert.equal(typeof snap.endedAt, 'number');
  const r = parseOrchestrator(fs.readFileSync(out.transcript, 'utf8').split('\n').filter(Boolean));
  assert.equal(r.isOrchestrator, true);
  assert.equal(r.imagePath, out.imagePath);
});

test('watchEvents reports a finished fixture worker as done with its report, and a running one as not done', (t) => {
  const cfg = tmpDir(t, 'fixture');
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
    const opts = { files: undefined, budget: 200000, finished };
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

test('a live fixture snapshot counts as live by the sessions rule', (t) => {
  const cfg = tmpDir(t, 'fixture');
  writeOrchestration(cfg, { topic: 'demo', sessionId: 'sess-live', live: true, workers: [] });
  const [s] = readSessions(getSessionsDir(cfg));
  assert.equal(typeof s.endedAt, 'undefined');
  assert.ok(Date.now() - s.lastActiveAt <= LIVE_WINDOW_MS);
});

test('no fixture record is dated in the future, live or ended', (t) => {
  const cfg = tmpDir(t, 'fixture');
  const steps = Array.from({ length: 40 }, (_, k) => ({ tool: 'Edit', file_path: `lib/f${k}.js` }));
  for (const live of [true, false]) {
    const out = writeOrchestration(cfg, { topic: `t${live}`, sessionId: `future-${live}`, live, workers: Array.from({ length: 15 }, (_, k) => ({ task: k + 1, steps: k === 0 ? steps : [], finished: true, merged: true, steer: 'x' })) });
    const files = [out.transcript, ...out.workerIds.slice(0, 3).map((id) => path.join(path.dirname(out.transcript), `future-${live}`, 'subagents', `agent-${id}.jsonl`))];
    const before = Date.now();
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        assert.ok(Date.parse(JSON.parse(line).timestamp) <= before, `${file}: ${line.slice(0, 80)}`);
      }
    }
  }
});

test('a dashboard note maps to the worker launched before it, not one launched after it in the same session', () => {
  const lines = [
    ...orchestratorLines(),
    metaNote('You steered Task 1 from the dashboard: go slower'),
    ...launch('ag2', 'bbb2', 'Task 1 worker again', workerPrompt(1)),
  ];
  const r = parseOrchestrator(lines);
  assert.deepEqual(r.steers.map((s) => [s.to, s.source]), [['aaa1', 'dashboard']]);
  assert.deepEqual(r.unmappedNotes, []);
});

test('a dashboard note with no earlier worker in its session is unmapped, even when a later worker has its task', () => {
  const lines = [
    typed('orchestrate the plan'),
    assistant(use('Skill', { skill: 'orchestrate' }, 'sk')),
    metaNote('You steered Task 1 from the dashboard: go slower'),
    ...launch('ag2', 'bbb2', 'Task 1 worker', workerPrompt(1)),
  ];
  const r = parseOrchestrator(lines);
  assert.deepEqual(r.steers, []);
  assert.deepEqual(r.unmappedNotes.map((n) => n.task), [1]);
});

const claimPrompt = (run, kind) => `Read ${IMAGE} in full, then every file it lists under "Read before starting", in that order. Then run /c/bin/orch-claim ${run} ${kind} and do the task it prints.`;

test('a prompt that runs orch-claim work is a worker with its run folder and no task', () => {
  const r = parseOrchestrator([...orchestratorLines().slice(0, 2), ...launch('agc', 'aaac', 'Task 3 worker', claimPrompt('/p/img.run', 'work'))]);
  const a = r.agents[0];
  assert.equal(a.role, 'worker');
  assert.equal(a.claimRun, '/p/img.run');
  assert.equal(a.claimKind, 'work');
  assert.equal(a.task, null);
});

test('a prompt that runs orch-claim review is a reviewer', () => {
  const r = parseOrchestrator([...orchestratorLines().slice(0, 2), ...launch('agr', 'aaar', 'orchestrate reviewer', claimPrompt('"/p/img.run"', 'review'))]);
  const a = r.agents[0];
  assert.deepEqual([a.role, a.claimRun, a.claimKind, a.task], ['reviewer', '/p/img.run', 'review', null]);
});

test('a claim prompt with a relative or /../ run folder gives claimRun null', () => {
  for (const run of ['img.run', '/p/../q/img.run', '/p/img']) {
    const r = parseOrchestrator([...orchestratorLines().slice(0, 2), ...launch('agb', 'aaab', 'orchestrate worker', claimPrompt(run, 'work'))]);
    assert.equal(r.agents[0].claimRun, null, run);
    assert.equal(r.agents[0].claimKind, 'work');
  }
});
