'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { buildReport, renderReport } = require('../lib/orchestrations/report');
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

test('read outside the image lists only files the image text does not name', () => {
  const r = build(CLAIM, { reads: { a1: ['/w/lib/a.js', '/w/lib/b.js'] }, imageText: 'Edit lib/a.js first.' });
  assert.deepEqual(agent(r, 'a1').readOutsideImage, ['/w/lib/b.js']);
  const full = build(CLAIM, { reads: { a1: ['/w/lib/a.js', '/other/c.js'] }, imageText: 'see /other/c.js' });
  assert.deepEqual(agent(full, 'a1').readOutsideImage, ['/w/lib/a.js']);
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

test('orch-report with a missing image exits 1', (t) => {
  const r = spawnSync(process.execPath, [REPORT, path.join(tmpDir(t, 'report'), 'nope.md')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-report: /);
});
