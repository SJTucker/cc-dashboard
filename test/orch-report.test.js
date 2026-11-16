'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { buildReport, renderReport, mergeSnapshot, transcriptSteps } = require('../lib/orchestrations/report');
const { costForUsage } = require('../lib/pricing');

const REPORT = path.join(__dirname, '..', 'bin', 'orch-report');
const T0 = Date.parse('2026-11-14T10:00:00Z');
const MIN = 60000;
const at = (m) => new Date(T0 + m * MIN).toISOString();
const ev = (m, kind, rest = {}) => ({ t: at(m), kind, ...rest });
const MODEL = 'claude-sonnet-4-20250514';

function build(events, extra = {}) {
  return buildReport({ events, steps: {}, reads: {}, imageText: '', ...extra });
}
const task = (report, n) => report.tasks.find((r) => r.task === n);
const agent = (report, id) => report.agents.find((r) => r.agent === id);

test('slot wait, wall time and attempts for one task', () => {
  const r = build([
    ev(0, 'ready', { task: 2 }),
    ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
    ev(3, 'claimed', { file: '0001-t2-a1.json', agent: 'a1', transcript: '/t/a1.jsonl', worktree: '/w' }),
    ev(15, 'added', { file: '0002-t2-a1.json', task: 2, attempt: 1, queue: 'review' }),
    ev(20, 'review-fail', { task: 2 }),
    ev(21, 'added', { file: '0003-t2-a2.json', task: 2, attempt: 2, queue: 'work' }),
    ev(22, 'claimed', { file: '0003-t2-a2.json', agent: 'a3', transcript: '/t/a3.jsonl', worktree: '/w' }),
    ev(40, 'review-pass', { task: 2 }),
    ev(41, 'merged', { task: 2 }),
  ]);
  const row = task(r, 2);
  assert.equal(row.slotWaitMs, 3 * MIN);
  assert.equal(row.wallMs, 41 * MIN);
  assert.equal(row.attempts, 2);
  assert.equal(row.reviewFail, 1);
  assert.equal(row.reviewPass, 1);
});

test('slot wait starts at the last ready before the first claim', () => {
  const r = build([
    ev(0, 'ready', { task: 2 }),
    ev(10, 'ready', { task: 2 }),
    ev(10, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
    ev(12, 'claimed', { file: '0001-t2-a1.json', agent: 'a1', transcript: '/t/a1.jsonl', worktree: '/w' }),
    ev(30, 'merged', { task: 2 }),
  ]);
  assert.equal(task(r, 2).slotWaitMs, 2 * MIN);
  assert.equal(task(r, 2).wallMs, 30 * MIN);
});

test('a task with no ready or merged event, like Task 0, runs from its first added to its last review pass', () => {
  const r = build([
    ev(0, 'added', { file: '0011-t0-a1.json', task: 0, attempt: 1, queue: 'work' }),
    ev(1, 'claimed', { file: '0011-t0-a1.json', agent: 'a1', transcript: '/t/a1.jsonl', worktree: '/w' }),
    ev(3, 'added', { file: '0012-t0-a1.json', task: 0, attempt: 1, queue: 'review' }),
    ev(7, 'review-fail', { task: 0 }),
    ev(9, 'review-pass', { task: 0 }),
  ]);
  assert.equal(task(r, 0).slotWaitMs, 1 * MIN);
  assert.equal(task(r, 0).wallMs, 9 * MIN);
});

test('waiting time sums each waiting to answered pair, and an open pair runs to the last event', () => {
  const r = build([
    ev(0, 'ready', { task: 2 }),
    ev(5, 'waiting', { task: 2 }),
    ev(9, 'answered', { task: 2 }),
    ev(30, 'waiting', { task: 2 }),
    ev(35, 'ready', { task: 3 }),
  ]);
  assert.equal(task(r, 2).waitingMs, 9 * MIN);
});

test('watch counts by name and steers and refusals per task', () => {
  const file = '0001-t2-a1.json';
  const r = build([
    ev(0, 'added', { file, task: 2, attempt: 1, queue: 'work' }),
    ev(1, 'watch', { file, agent: 'a1', name: 'DRIFT', text: 'x' }),
    ev(2, 'watch', { file, agent: 'a1', name: 'DRIFT', text: 'y' }),
    ev(3, 'watch', { file, agent: 'a1', name: 'QUIET', text: '' }),
    ev(4, 'steer', { task: 2, agent: 'a1' }),
    ev(5, 'denied', { file, agent: 'a1', text: '/x' }),
  ]);
  const row = task(r, 2);
  assert.deepEqual(row.watch, { DRIFT: 2, QUIET: 1 });
  assert.equal(row.steers, 1);
  assert.equal(row.denied, 1);
});

const CLAIM = [
  ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
  ev(0, 'claimed', { file: '0001-t2-a1.json', agent: 'a1', transcript: '/t/a1.jsonl', worktree: '/w' }),
];

test('agent cost, peak context and cache read share come from steps', () => {
  const s1 = { model: MODEL, t: T0 + MIN, input: 100, cacheRead: 900, cacheWrite: 0, output: 50 };
  const s2 = { model: MODEL, t: T0 + 2 * MIN, input: 200, cacheRead: 1800, cacheWrite: 1000, output: 10 };
  const r = build(CLAIM, { steps: { a1: [s1, s2] }, reads: { a1: [] } });
  const a = agent(r, 'a1');
  assert.equal(a.peakContext, 3000);
  assert.equal(a.cacheReadShare, 2700 / 4000);
  const price = (s) =>
    costForUsage({ input_tokens: s.input, cache_read_input_tokens: s.cacheRead, cache_creation_input_tokens: s.cacheWrite, output_tokens: s.output }, s.model, s.t).cost;
  assert.equal(a.cost, price(s1) + price(s2));
  assert.ok(a.cost > 0);
  assert.equal(a.queue, 'work');
  assert.equal(a.file, '0001-t2-a1.json');
});

test('an agent with a step on an unknown model gets a null cost, and run.cost leaves that agent out', () => {
  const ok = { model: MODEL, t: T0 + MIN, input: 100, cacheRead: 900, cacheWrite: 0, output: 50 };
  const bad = { model: 'not-a-model', t: T0 + 2 * MIN, input: 100, cacheRead: 0, cacheWrite: 0, output: 50 };
  const r = build(CLAIM, { steps: { a1: [ok, bad] }, reads: { a1: [] } });
  assert.equal(agent(r, 'a1').cost, null);
  assert.equal(agent(r, 'a1').peakContext, 1000);
  assert.equal(r.run.cost, null);
  assert.match(renderReport(r), /n\/a/);
});

test('read outside the image lists only files the image text does not name', () => {
  const r = build(CLAIM, { reads: { a1: ['/w/lib/a.js', '/w/lib/b.js'] }, imageText: 'Edit lib/a.js first.' });
  assert.deepEqual(agent(r, 'a1').readOutsideImage, ['/w/lib/b.js']);
  const full = build(CLAIM, { reads: { a1: ['/w/lib/a.js', '/other/c.js'] }, imageText: 'see /other/c.js' });
  assert.deepEqual(agent(full, 'a1').readOutsideImage, ['/w/lib/a.js']);
});

test('read outside the image leaves out the image file itself', () => {
  const r = build(CLAIM, { reads: { a1: ['/repo/image.md', '/w/lib/b.js'] }, imagePath: '/repo/image.md' });
  assert.deepEqual(agent(r, 'a1').readOutsideImage, ['/w/lib/b.js']);
});

test('an agent with no steps or no transcript gets nulls', () => {
  const r = build(CLAIM, { steps: {}, reads: { a1: null } });
  const a = agent(r, 'a1');
  assert.equal(a.cost, null);
  assert.equal(a.peakContext, null);
  assert.equal(a.cacheReadShare, null);
  assert.equal(a.readOutsideImage, null);
  assert.match(renderReport(r), /n\/a/);
});

test('meanRunning averages overlapping agents over the run', () => {
  const step = (m) => ({ model: MODEL, t: T0 + m * MIN, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
  const r = build(
    [
      ev(0, 'added', { file: '0001-t1-a1.json', task: 1, attempt: 1, queue: 'work' }),
      ev(0, 'claimed', { file: '0001-t1-a1.json', agent: 'a1', transcript: '/t/a1.jsonl', worktree: '/w' }),
      ev(5, 'claimed', { file: '0002-t2-a1.json', agent: 'a2', transcript: '/t/a2.jsonl', worktree: '/w' }),
      ev(20, 'merged', { task: 1 }),
    ],
    { steps: { a1: [step(10)], a2: [step(15)] } },
  );
  assert.equal(r.run.meanRunning, 1);
  assert.equal(r.run.agents, 2);
  assert.equal(r.run.start, at(0));
  assert.equal(r.run.end, at(20));
});

function writeRun(base) {
  const image = path.join(base, 'img.md');
  const run = path.join(base, 'img.run');
  fs.mkdirSync(run);
  fs.writeFileSync(image, 'Edit lib/a.js.\n');
  const events = [
    ev(0, 'ready', { task: 2 }),
    ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
    ev(3, 'claimed', { file: '0001-t2-a1.json', agent: 'a1', transcript: path.join(base, 'none.jsonl'), worktree: '/w' }),
    ev(41, 'merged', { task: 2 }),
  ];
  fs.writeFileSync(path.join(run, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return image;
}

test('orch-report prints a row per task and exits 0', (t) => {
  const base = tmpDir(t, 'report');
  const image = writeRun(base);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'cfg') };
  const r = spawnSync(process.execPath, [REPORT, image], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Task 2/);
  assert.match(r.stdout, /n\/a/);
  const j = spawnSync(process.execPath, [REPORT, image, '--json'], { encoding: 'utf8', env });
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).tasks[0].task, 2);
});

const usageLine = (m, id, req, usage, model = MODEL) =>
  JSON.stringify({ type: 'assistant', timestamp: at(m), requestId: req, message: { id, model, usage } });

test('transcriptSteps counts each response once, with its largest usage', () => {
  const steps = transcriptSteps([
    usageLine(1, 'm1', 'r1', { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 3 }),
    usageLine(1, 'm1', 'r1', { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 40 }),
    usageLine(2, 'm2', 'r2', { input_tokens: 1, cache_read_input_tokens: 300, output_tokens: 7 }),
    usageLine(3, 'm3', 'r3', { input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
    JSON.stringify({ type: 'user', timestamp: at(4), message: { content: 'hi' } }),
    'not json',
  ]);
  assert.deepEqual(steps, [
    { t: T0 + MIN, model: MODEL, input: 5, cacheRead: 100, cacheWrite: 20, output: 40 },
    { t: T0 + 2 * MIN, model: MODEL, input: 1, cacheRead: 300, cacheWrite: 0, output: 7 },
  ]);
});

test('orch-report falls back to the transcript when the agent has no agent-usage file', (t) => {
  const base = tmpDir(t, 'report');
  const image = writeRun(base);
  fs.writeFileSync(path.join(base, 'none.jsonl'), usageLine(5, 'm1', 'r1', { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }) + '\n');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'cfg') };
  const j = spawnSync(process.execPath, [REPORT, image, '--json'], { encoding: 'utf8', env });
  assert.equal(j.status, 0, j.stderr);
  const a = JSON.parse(j.stdout).agents[0];
  assert.equal(a.peakContext, 100);
  assert.equal(a.cacheReadShare, 0.9);
  assert.ok(a.cost > 0);
});

test('orch-report with a missing image exits 1', (t) => {
  const r = spawnSync(process.execPath, [REPORT, path.join(tmpDir(t, 'report'), 'nope.md')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-report: /);
});

test('addTask writes the task title into the added event', (t) => {
  const run = path.join(tmpDir(t, 'report-add'), 'img.run');
  fs.mkdirSync(run, { recursive: true });
  require('../lib/orchestrations/claims').addTask(run, 'work', {
    task: 3, title: 'Fix the regex', plan: 'p.md', worktree: '/w', doneWhen: 'x', files: ['a.js'],
  });
  const lines = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.kind, 'added');
  assert.equal(last.title, 'Fix the regex');
});

test('a task row carries the title of its added events', () => {
  const r = build([
    ev(0, 'added', { file: '0001-t2-a1.json', task: 2, title: 'Fix the regex', attempt: 1, queue: 'work' }),
    ev(5, 'added', { file: '0002-t2-a1.json', task: 2, title: 'Fix the regex', attempt: 1, queue: 'review' }),
  ]);
  assert.equal(task(r, 2).title, 'Fix the regex');
});

test('a task whose added events disagree on the title gets no title', () => {
  const r = build([
    ev(0, 'added', { file: '0001-t0-a1.json', task: 0, title: 'Stub A', attempt: 1, queue: 'work' }),
    ev(1, 'added', { file: '0002-t0-a1.json', task: 0, title: 'Fix B', attempt: 1, queue: 'work' }),
  ]);
  assert.strictEqual(task(r, 0).title, null);
});

test('a run logged before titles gets no title', () => {
  const r = build([ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' })]);
  assert.strictEqual(task(r, 2).title, null);
});

test('renderReport labels a titled task Task N (<title>)', () => {
  const titled = renderReport(build([ev(0, 'added', { file: '0001-t2-a1.json', task: 2, title: 'Fix the regex', attempt: 1, queue: 'work' })]));
  assert.match(titled, /Task 2 \(Fix the regex\)/);
  const bare = renderReport(build([ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' })]));
  assert.match(bare, /Task 2(?! \()/);
});

// Task 2: role split, first-request cache share, steer and question texts.
const price = (s) =>
  costForUsage({ input_tokens: s.input, cache_read_input_tokens: s.cacheRead, cache_creation_input_tokens: s.cacheWrite, output_tokens: s.output }, s.model, s.t).cost;
const step = (m, over = {}) => ({ model: MODEL, t: T0 + m * MIN, input: 100, cacheRead: 900, cacheWrite: 0, output: 50, ...over });
const ROLES = [
  ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
  ev(1, 'claimed', { file: '0001-t2-a1.json', agent: 'w1', transcript: '/t/w1.jsonl', worktree: '/w' }),
  ev(10, 'added', { file: '0002-t2-a1.json', task: 2, attempt: 1, queue: 'review' }),
  ev(11, 'claimed', { file: '0002-t2-a1.json', agent: 'r1', transcript: '/t/r1.jsonl', worktree: '/w' }),
];

test('cost splits into implCost and reviewCost per task', () => {
  const w = [step(2), step(3)];
  const rv = [step(12)];
  const r = build(ROLES, { steps: { w1: w, r1: rv } });
  assert.equal(task(r, 2).implCost, price(w[0]) + price(w[1]));
  assert.equal(task(r, 2).reviewCost, price(rv[0]));
  assert.equal(r.run.cost, task(r, 2).implCost + task(r, 2).reviewCost);
  assert.equal(agent(r, 'w1').role, 'implementer');
  assert.equal(agent(r, 'r1').role, 'reviewer');
  assert.equal(agent(r, 'w1').task, 2);
  assert.equal(agent(r, 'w1').model, MODEL);
});

test('a second attempt adds to implCost', () => {
  const r = build(
    [
      ...ROLES,
      ev(20, 'added', { file: '0003-t2-a2.json', task: 2, attempt: 2, queue: 'work' }),
      ev(21, 'claimed', { file: '0003-t2-a2.json', agent: 'w2', transcript: '/t/w2.jsonl', worktree: '/w' }),
    ],
    { steps: { w1: [step(2)], w2: [step(22)], r1: [step(12)] } },
  );
  assert.equal(task(r, 2).implCost, price(step(2)) + price(step(22)));
});

test('an unpriced model gives null reviewCost and leaves implCost alone', () => {
  const r = build(ROLES, { steps: { w1: [step(2)], r1: [step(12, { model: 'not-a-model' })] } });
  assert.strictEqual(task(r, 2).reviewCost, null);
  assert.equal(task(r, 2).implCost, price(step(2)));
});

test('an agent role with no steps gives a null cost for that role', () => {
  const r = build(ROLES, { steps: { w1: [step(2)] } });
  assert.strictEqual(task(r, 2).reviewCost, null);
});

test('firstCacheShare uses only the earliest step', () => {
  const late = step(5, { input: 1000, cacheRead: 0, cacheWrite: 0 });
  const early = step(2, { input: 100, cacheRead: 300, cacheWrite: 100 });
  const r = build(CLAIM, { steps: { a1: [late, early] } });
  assert.equal(agent(r, 'a1').firstCacheShare, 300 / 500);
});

test('firstCacheShare is null when the first step has no input or cache tokens', () => {
  const r = build(CLAIM, { steps: { a1: [step(2, { input: 0, cacheRead: 0, cacheWrite: 0 })] } });
  assert.strictEqual(agent(r, 'a1').firstCacheShare, null);
});

test('the final-review agent gets role final, its cost lands in run.finalCost and in run.cost', () => {
  const f = [step(30), step(31)];
  const r = build(
    [...ROLES, ev(30, 'final-review', { agent: 'f1' }), ev(40, 'merged', { task: 2 })],
    { steps: { w1: [step(2)], r1: [step(12)], f1: f } },
  );
  const row = agent(r, 'f1');
  assert.equal(row.role, 'final');
  assert.strictEqual(row.task, null);
  assert.strictEqual(row.queue, null);
  assert.strictEqual(row.file, null);
  assert.strictEqual(row.readOutsideImage, null);
  assert.equal(r.run.finalCost, price(f[0]) + price(f[1]));
  assert.equal(r.run.cost, price(step(2)) + price(step(12)) + r.run.finalCost);
  assert.equal(r.run.finalPartial, false);
  assert.ok(Number.isFinite(r.run.meanRunning));
});

test('role is implementer for a claimed file with no added event', () => {
  const r = build([ev(0, 'claimed', { file: '0001-t2-a1.json', agent: 'a1', transcript: '/t/a1.jsonl', worktree: '/w' })]);
  assert.equal(agent(r, 'a1').role, 'implementer');
});

test('a waiting event with no text adds nothing to questions', () => {
  const r = build([ev(0, 'ready', { task: 2 }), ev(1, 'waiting', { task: 2 }), ev(2, 'waiting', { task: 2, text: 7 }), ev(3, 'waiting', { task: 2, text: 'Which db?' })]);
  assert.deepEqual(task(r, 2).questions, ['Which db?']);
});

test('steerTexts and questions list event text in order', () => {
  const r = build([
    ev(0, 'ready', { task: 2 }),
    ev(1, 'steer', { task: 2, text: 'first' }),
    ev(2, 'waiting', { task: 2, text: 'q1' }),
    ev(3, 'steer', { task: 2, text: 'second' }),
    ev(4, 'steer', { task: 2 }),
    ev(5, 'waiting', { task: 2, text: 'q2' }),
  ]);
  assert.deepEqual(task(r, 2).steerTexts, ['first', 'second']);
  assert.deepEqual(task(r, 2).questions, ['q1', 'q2']);
  assert.equal(task(r, 2).steers, 3);
});

test('renderReport prints Impl, Review, 1st cache columns and a Final line', () => {
  const r = build([...ROLES, ev(30, 'final-review', { agent: 'f1' })], { steps: { w1: [step(2)], r1: [step(12)], f1: [step(31)] } });
  const text = renderReport(r);
  for (const s of ['Impl', 'Review', '1st cache', 'Final review']) assert.ok(text.includes(s), s);
});

test('renderReport marks a partial final cost with a lower-bound sign', () => {
  const r = build([ev(0, 'final-review', { agent: 'f1' })], { steps: { f1: [step(1)] } });
  r.run.finalPartial = true;
  assert.match(renderReport(r), /Final review[^\n]*≥\$/);
});

test('renderReport lists steers and questions', () => {
  const r = build([ev(0, 'ready', { task: 2 }), ev(1, 'steer', { task: 2, text: 'use the helper' }), ev(2, 'waiting', { task: 2, text: 'Which db?' })]);
  const text = renderReport(r);
  assert.match(text, /Steers:\n\s*Task 2: use the helper/);
  assert.match(text, /Questions:\n\s*Task 2: Which db\?/);
  const bare = renderReport(build([ev(0, 'ready', { task: 2 })]));
  assert.ok(!bare.includes('Steers:'));
  assert.ok(!bare.includes('Questions:'));
});

test('bin/orch-report reads the final review and the agents it started', (t) => {
  const base = tmpDir(t, 'report-final');
  const run = path.join(base, 'img.run');
  const image = path.join(base, 'img.md');
  const cfg = path.join(base, 'cfg');
  const usage = path.join(cfg, 'cc-dashboard', 'agent-usage');
  const subs = path.join(base, 'subagents');
  fs.mkdirSync(run);
  fs.mkdirSync(usage, { recursive: true });
  fs.mkdirSync(subs);
  fs.writeFileSync(image, 'x\n');
  const events = [
    ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
    ev(1, 'claimed', { file: '0001-t2-a1.json', agent: 'w1', transcript: path.join(subs, 'agent-w1.jsonl'), worktree: '/w' }),
    ev(30, 'final-review', { agent: 'f1' }),
  ];
  fs.writeFileSync(path.join(run, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(subs, 'agent-c1.meta.json'), JSON.stringify({ parentAgentId: 'f1', spawnDepth: 2 }));
  fs.writeFileSync(path.join(subs, 'agent-c2.meta.json'), JSON.stringify({ parentAgentId: 'c1', spawnDepth: 3 }));
  fs.writeFileSync(path.join(subs, 'agent-x1.meta.json'), JSON.stringify({ parentAgentId: 'zz' }));
  const stepsFile = (id, s) => fs.writeFileSync(path.join(usage, `${id}.json`), JSON.stringify({ agentId: id, steps: s }));
  const fs1 = step(31);
  const cs1 = step(32);
  const cs2 = step(33);
  stepsFile('f1', [fs1]);
  stepsFile('c1', [cs1]);
  stepsFile('c2', [cs2]);
  stepsFile('x1', [step(34)]);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const out = JSON.parse(spawnSync(process.execPath, [REPORT, image, '--json'], { encoding: 'utf8', env }).stdout);
  const row = out.agents.find((a) => a.role === 'final');
  assert.equal(row.cost, price(fs1) + price(cs1) + price(cs2));
  assert.equal(out.run.finalPartial, false);
  fs.rmSync(path.join(usage, 'c1.json'));
  // With report.json from the complete run, the saved larger cost and finalPartial false win.
  const merged = JSON.parse(spawnSync(process.execPath, [REPORT, image, '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(merged.agents.find((a) => a.role === 'final').cost, price(fs1) + price(cs1) + price(cs2));
  assert.equal(merged.run.finalPartial, false);
  // Without it, the missing child file makes the final review partial.
  fs.rmSync(path.join(run, 'report.json'));
  const again = JSON.parse(spawnSync(process.execPath, [REPORT, image, '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(again.run.finalPartial, true);
});

test('renderReport prints no lower-bound sign when finalCost is null', () => {
  const r = build([ev(0, 'final-review', { agent: 'f1' })]);
  r.run.finalPartial = true;
  assert.strictEqual(r.run.finalCost, null);
  assert.doesNotMatch(renderReport(r), /≥/);
});

function finalRun(t, { twoDirs = false } = {}) {
  const base = tmpDir(t, 'report-final2');
  const run = path.join(base, 'img.run');
  const cfg = path.join(base, 'cfg');
  const subs = path.join(base, 'subagents');
  const subs2 = path.join(base, 'other', 'subagents');
  fs.mkdirSync(run);
  fs.mkdirSync(path.join(cfg, 'cc-dashboard', 'agent-usage'), { recursive: true });
  fs.mkdirSync(subs);
  fs.mkdirSync(subs2, { recursive: true });
  fs.writeFileSync(path.join(base, 'img.md'), 'x\n');
  const events = [
    ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
    ev(1, 'claimed', { file: '0001-t2-a1.json', agent: 'w1', transcript: path.join(subs, 'agent-w1.jsonl'), worktree: '/w' }),
    ev(2, 'claimed', { file: '0002-t3-a1.json', agent: 'w2', transcript: path.join(subs2, 'agent-w2.jsonl'), worktree: '/w' }),
    ev(30, 'final-review', { agent: 'f1' }),
  ];
  fs.writeFileSync(path.join(run, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(twoDirs ? subs : subs2, 'agent-c1.meta.json'), JSON.stringify({ parentAgentId: 'f1' }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const usage = path.join(cfg, 'cc-dashboard', 'agent-usage');
  const go = () => JSON.parse(spawnSync(process.execPath, [REPORT, path.join(base, 'img.md'), '--json'], { encoding: 'utf8', env }).stdout);
  return { usage, go, run, base, env };
}

test('bin/orch-report: an expired final agent and child leave finalPartial false', (t) => {
  const { go } = finalRun(t);
  const out = go();
  assert.strictEqual(out.run.finalPartial, false);
  assert.strictEqual(out.run.finalCost, null);
});

test('bin/orch-report finds a final-review child in any claimed transcript folder', (t) => {
  const { usage, go } = finalRun(t, { twoDirs: true });
  fs.writeFileSync(path.join(usage, 'f1.json'), JSON.stringify({ agentId: 'f1', steps: [step(31)] }));
  fs.writeFileSync(path.join(usage, 'c1.json'), JSON.stringify({ agentId: 'c1', steps: [step(32)] }));
  const out = go();
  assert.strictEqual(out.agents.find((a) => a.role === 'final').cost, price(step(31)) + price(step(32)));
});

// A report for run events with one worker, one reviewer and a final-review agent.
const SNAP_EVENTS = [...ROLES, ev(30, 'final-review', { agent: 'f1' }), ev(40, 'merged', { task: 2 })];
const snap = (steps, extra = {}) => build(SNAP_EVENTS, { steps, ...extra });
const FULL = () => snap({ w1: [step(2)], r1: [step(12)], f1: [step(31)] });
const EXPIRED = () => snap({ w1: [], r1: [], f1: [] });

test('mergeSnapshot fills a null cost, peakContext and firstCacheShare from the previous report', () => {
  const prev = FULL();
  const merged = mergeSnapshot(EXPIRED(), prev);
  for (const id of ['w1', 'r1', 'f1']) {
    assert.equal(agent(merged, id).cost, agent(prev, id).cost);
    assert.equal(agent(merged, id).peakContext, agent(prev, id).peakContext);
    assert.equal(agent(merged, id).firstCacheShare, agent(prev, id).firstCacheShare);
    assert.equal(agent(merged, id).model, MODEL);
  }
  assert.equal(task(merged, 2).implCost, task(prev, 2).implCost);
  assert.equal(task(merged, 2).reviewCost, task(prev, 2).reviewCost);
  assert.equal(merged.run.finalCost, prev.run.finalCost);
});

test('mergeSnapshot keeps a non-null value over the previous one', () => {
  const prev = FULL();
  const next = snap({ w1: [step(2, { input: 500 })], r1: [step(12)], f1: [step(31)] });
  const merged = mergeSnapshot(next, prev);
  assert.equal(agent(merged, 'w1').peakContext, 1400);
  assert.equal(agent(merged, 'w1').cost, agent(next, 'w1').cost);
});

test('mergeSnapshot recomputes run.cost from the merged agents', () => {
  const prev = FULL();
  const next = snap({ w1: [step(2)], r1: [], f1: [] });
  const merged = mergeSnapshot(next, prev);
  assert.equal(merged.run.cost, prev.run.cost);
  assert.equal(merged.run.cost, agent(prev, 'w1').cost + agent(prev, 'r1').cost + agent(prev, 'f1').cost);
  assert.strictEqual(mergeSnapshot(EXPIRED(), EXPIRED()).run.cost, null);
});

test('mergeSnapshot keeps the larger of two non-null costs', () => {
  const prev = FULL();
  const next = snap({ w1: [step(2, { input: 1, cacheRead: 1, output: 1 })], r1: [step(12)], f1: [step(31)] });
  const merged = mergeSnapshot(next, prev);
  assert.equal(agent(merged, 'w1').cost, agent(prev, 'w1').cost);
  assert.equal(agent(merged, 'w1').peakContext, agent(prev, 'w1').peakContext);
  assert.equal(task(merged, 2).implCost, agent(prev, 'w1').cost);
  const bigger = snap({ w1: [step(2, { output: 99999 })], r1: [step(12)], f1: [step(31)] });
  assert.equal(agent(mergeSnapshot(bigger, prev), 'w1').cost, agent(bigger, 'w1').cost);
});

test('mergeSnapshot keeps the previous meanRunning when a cost was filled from prev', () => {
  const prev = FULL();
  const next = EXPIRED();
  assert.notEqual(next.run.meanRunning, prev.run.meanRunning);
  assert.equal(mergeSnapshot(next, prev).run.meanRunning, prev.run.meanRunning);
  const other = FULL();
  other.run.meanRunning = 123;
  assert.equal(mergeSnapshot(FULL(), other).run.meanRunning, FULL().run.meanRunning);
});

test('mergeSnapshot keeps the next meanRunning when only a larger previous cost won', () => {
  const prev = FULL();
  prev.run.meanRunning = 0.4;
  const next = snap({ w1: [step(2, { input: 1, cacheRead: 1, output: 1 })], r1: [step(12)], f1: [step(31)] });
  next.run.meanRunning = 2.1;
  const merged = mergeSnapshot(next, prev);
  assert.equal(agent(merged, 'w1').cost, agent(prev, 'w1').cost);
  assert.equal(merged.run.meanRunning, 2.1);
});

test('mergeSnapshot returns unknown keys unchanged and a null prev returns next', () => {
  const next = EXPIRED();
  next.extra = { a: 1 };
  next.run.note = 'x';
  next.agents[0].tag = 't';
  const merged = mergeSnapshot(next, FULL());
  assert.deepEqual(merged.extra, { a: 1 });
  assert.equal(merged.run.note, 'x');
  assert.equal(merged.agents[0].tag, 't');
  assert.equal(mergeSnapshot(next, null), next);
});

test('mergeSnapshot takes finalPartial from prev when it fills finalCost', () => {
  const prev = FULL();
  prev.run.finalPartial = true;
  const merged = mergeSnapshot(EXPIRED(), prev);
  assert.equal(merged.run.finalCost, prev.run.finalCost);
  assert.strictEqual(merged.run.finalPartial, true);
  const kept = FULL();
  kept.run.finalPartial = false;
  assert.strictEqual(mergeSnapshot(FULL(), prev).run.finalPartial, false);
  assert.strictEqual(mergeSnapshot(EXPIRED(), kept).run.finalPartial, false);
});

test('orch-report saves report.json and prints the same costs after the step files expire', (t) => {
  const base = tmpDir(t, 'report-snap');
  const run = path.join(base, 'img.run');
  const image = path.join(base, 'img.md');
  const cfg = path.join(base, 'cfg');
  const usage = path.join(cfg, 'cc-dashboard', 'agent-usage');
  fs.mkdirSync(run);
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(image, 'x\n');
  const events = [
    ev(0, 'added', { file: '0001-t2-a1.json', task: 2, attempt: 1, queue: 'work' }),
    ev(1, 'claimed', { file: '0001-t2-a1.json', agent: 'w1', transcript: path.join(base, 'none.jsonl'), worktree: '/w' }),
    ev(9, 'merged', { task: 2 }),
  ];
  fs.writeFileSync(path.join(run, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(usage, 'w1.json'), JSON.stringify({ agentId: 'w1', steps: [step(2)] }));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const go = () => JSON.parse(spawnSync(process.execPath, [REPORT, image, '--json'], { encoding: 'utf8', env }).stdout);
  const first = go();
  assert.equal(first.agents[0].cost, price(step(2)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'report.json'), 'utf8')), first);
  fs.rmSync(path.join(usage, 'w1.json'));
  const second = go();
  assert.equal(second.agents[0].cost, first.agents[0].cost);
  assert.equal(second.run.cost, first.run.cost);
  fs.writeFileSync(path.join(run, 'report.json'), '{not json');
  assert.strictEqual(go().agents[0].cost, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'report.json'), 'utf8')).tasks[0].task, 2);
});

test('mergeSnapshot takes finalPartial from prev when prev has the larger final cost', () => {
  const prev = snap({ w1: [step(2)], r1: [step(12)], f1: [step(31, { output: 99999 })] });
  prev.run.finalPartial = false;
  const next = snap({ w1: [step(2)], r1: [step(12)], f1: [step(31, { output: 1 })] }, { finalPartial: true });
  const merged = mergeSnapshot(next, prev);
  assert.equal(merged.run.finalCost, agent(prev, 'f1').cost);
  assert.strictEqual(merged.run.finalPartial, false);
});

test('mergeSnapshot keeps the previous meanRunning when only a peakContext was filled', () => {
  const odd = (m) => step(m, { model: 'no-such-model' });
  const prev = snap({ w1: [odd(2)], r1: [], f1: [] });
  const next = snap({ w1: [], r1: [], f1: [] });
  assert.strictEqual(agent(prev, 'w1').cost, null);
  assert.notEqual(next.run.meanRunning, prev.run.meanRunning);
  const merged = mergeSnapshot(next, prev);
  assert.equal(agent(merged, 'w1').peakContext, 1000);
  assert.equal(merged.run.meanRunning, prev.run.meanRunning);
});

test('mergeSnapshot ignores a previous report whose agents are not objects', () => {
  const next = FULL();
  const merged = mergeSnapshot(next, { agents: [null, 'x', 3] });
  assert.equal(merged.run.cost, next.run.cost);
  assert.equal(agent(merged, 'w1').cost, agent(next, 'w1').cost);
});

test('bin/orch-report prints the report and exits 0 when report.json cannot be saved', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores folder permissions');
  const { run, base, env } = finalRun(t);
  fs.chmodSync(run, 0o555);
  let res;
  try {
    res = spawnSync(process.execPath, [REPORT, path.join(base, 'img.md')], { encoding: 'utf8', env });
  } finally {
    fs.chmodSync(run, 0o755);
  }
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Run: /);
  assert.match(res.stderr, /orch-report: could not save report\.json/);
  assert.ok(!fs.existsSync(path.join(run, 'report.json')));
});

test('bin/orch-report falls back to transcripts for the final agent and its children', (t) => {
  const { go, base } = finalRun(t, { twoDirs: true });
  const subs = path.join(base, 'subagents');
  const line = (id, out) => JSON.stringify({ timestamp: at(31), requestId: `r${id}`, message: { id: `m${id}`, model: MODEL, usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } } });
  fs.writeFileSync(path.join(subs, 'agent-f1.jsonl'), line('f', 10) + '\n');
  fs.writeFileSync(path.join(subs, 'agent-c1.jsonl'), line('c', 20) + '\n');
  const out = go();
  const row = out.agents.find((a) => a.role === 'final');
  const usage = (out_) => ({ input: 1000, cacheRead: 0, cacheWrite: 0, output: out_, model: MODEL, t: Date.parse(at(31)) });
  assert.equal(row.cost, price(usage(10)) + price(usage(20)));
  assert.equal(out.run.finalPartial, false);
  fs.rmSync(path.join(subs, 'agent-c1.jsonl'));
  fs.rmSync(path.join(base, 'img.run', 'report.json'), { force: true });
  assert.equal(go().run.finalPartial, true);
});
