'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionFeed, nowLine } = require('../lib/orchestrations/feed.js');
const { parseOrchestrator } = require('../lib/orchestrations/parse.js');
const { stepsOf } = require('../lib/transcript-index.js');

const T0 = Date.parse('2026-11-10T10:00:00Z');
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const IMAGE = '/p/docs/superpowers/images/2026-11-10-demo.md';

class Script {
  constructor() {
    this.lines = [];
  }
  push(rec) {
    this.lines.push(JSON.stringify({ timestamp: iso(this.lines.length), ...rec }));
    return this;
  }
  prompt(t) {
    return this.push({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: t } });
  }
  text(t) {
    return this.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  }
  use(name, input, id = `id${this.lines.length}`) {
    return this.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }
  agentResult(id, agentId, prompt) {
    return this.push({ type: 'user', toolUseResult: { agentId, prompt }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  }
}

const workerPrompt = (n) =>
  [
    `Your worktree is /p/.worktrees/demo-t${n}; work only there on branch demo-t${n}.`,
    `Read ${IMAGE} in full, then do Task ${n} of /p/docs/superpowers/plans/demo.md, "Title ${n}".`,
    'Files this task touches: lib/a.js, lib/b.js.',
    'Done when: tests pass',
  ].join('\n') + '\n';

function orchestration() {
  const s = new Script();
  s.prompt('Orchestrate the demo plan please');
  s.use('Skill', { skill: 'orchestrate' });
  s.use('Write', { file_path: IMAGE, content: 'x' });
  s.use('Bash', { command: 'wt switch --create demo --base main --no-cd' });
  s.use('Read', { file_path: '/p/lib/x.js' });
  s.use('Grep', { pattern: 'foo' });
  s.use('Agent', { description: 'Task 1 worker', prompt: workerPrompt(1) }, 'ag1');
  s.agentResult('ag1', 'a1', workerPrompt(1));
  s.use('Monitor', { description: 'watch Task 1 progress', command: 'tail -f board' });
  s.use('SendMessage', { to: 'a1', summary: 'use the helper', message: 'long' });
  s.use('Bash', { command: 'git merge demo-t1 -m "merge Task 1"' });
  return s;
}

const feedOf = (s, opts = {}) => {
  const parsed = parseOrchestrator(s.lines);
  return { parsed, feed: actionFeed(s.lines, parsed, opts) };
};

test('maps orchestrator steps to plain actions, newest first', () => {
  const { feed } = feedOf(orchestration());
  assert.deepEqual(
    feed.map((a) => a.text),
    ['Merged Task 1', 'Steered Task 1', 'Watching Task 1', 'Started Task 1 worker', 'Created worktree demo', 'Wrote the context image', 'Loaded orchestrate', 'You: Orchestrate the demo plan please'],
  );
  const byText = Object.fromEntries(feed.map((a) => [a.text, a]));
  assert.equal(byText['Started Task 1 worker'].glyph, '▸');
  assert.equal(byText['Started Task 1 worker'].detail, 'lib/a.js, lib/b.js');
  assert.equal(byText['Steered Task 1'].detail, 'use the helper');
  assert.equal(byText['Merged Task 1'].glyph, '✓');
  assert.equal(byText['Merged Task 1'].at, iso(10));
  assert.equal(byText['Merged Task 1'].line, 11);
});

test('leaves out reads and greps', () => {
  const { feed } = feedOf(orchestration());
  assert.ok(!feed.some((a) => /Read|Grep|x\.js|foo/.test(a.text)));
  assert.equal(feed.length, 8);
});

test('keeps at most 30 entries', () => {
  const s = orchestration();
  for (let i = 0; i < 40; i++) s.use('SendMessage', { to: 'a1', summary: `s${i}` });
  const { feed } = feedOf(s);
  assert.equal(feed.length, 30);
  assert.equal(feed[0].detail, 's39');
  assert.equal(actionFeed(s.lines, parseOrchestrator(s.lines), { limit: 5 }).length, 5);
});

test('an Agent step with no result yet is Started agent with its description', () => {
  const s = orchestration();
  s.use('Agent', { description: 'scan the repo', prompt: 'look' }, 'ag2');
  const { feed } = feedOf(s);
  assert.equal(feed[0].text, 'Started agent');
  assert.equal(feed[0].detail, 'scan the repo');
});

test('a reviewer is Started review of Task N', () => {
  const s = orchestration();
  s.use('Agent', { description: 'Review Task 1', prompt: 'review Task 1' }, 'rv');
  s.agentResult('rv', 'r1', 'review Task 1');
  const { feed } = feedOf(s);
  assert.equal(feed[0].text, 'Started review of Task 1');
  assert.equal(feed[0].glyph, '◐');
});

test('merge entries agree with parseOrchestrator: merge-base is ignored, a repeat merge appears once', () => {
  const s = orchestration();
  s.use('Bash', { command: 'git merge-base demo demo-t1' });
  s.use('Bash', { command: 'git merge demo-t1' });
  s.use('Bash', { command: 'git merge --abort' });
  const { parsed, feed } = feedOf(s);
  assert.equal(parsed.merges.length, 1);
  assert.equal(feed.filter((a) => a.text.startsWith('Merged')).length, 1);
});

test('wt remove of a task branch counts as a merge', () => {
  const s = orchestration();
  s.use('Bash', { command: 'wt remove demo-t2' });
  const { feed } = feedOf(s);
  assert.equal(feed[0].text, 'Merged Task 2');
});

test('checking a worker with transcript-index, and later image writes', () => {
  const s = orchestration();
  s.use('Bash', { command: 'node bin/transcript-index a1 --steps' });
  s.use('Edit', { file_path: IMAGE, old_string: 'a', new_string: 'b' });
  const { feed } = feedOf(s);
  assert.deepEqual(feed.slice(0, 2).map((a) => a.text), ['Updated the image', "Checked Task 1's steps"]);
});

const stepsFor = (s) => stepsOf(s.lines, 1, s.lines.length);

test('waiting activity says Waiting for you with the last reply', () => {
  const s = orchestration().text('x'.repeat(200));
  const parsed = parseOrchestrator(s.lines);
  const now = nowLine(parsed, stepsFor(s), { state: 'waiting', tool: null, since: T0 }, true);
  assert.equal(now.state, 'waiting');
  assert.equal(now.text, 'Waiting for you');
  assert.equal(now.detail, 'x'.repeat(140));
  assert.equal(now.since, iso(0));
});

test('working activity describes the latest tool step', () => {
  const s = orchestration();
  const parsed = parseOrchestrator(s.lines);
  const now = nowLine(parsed, stepsFor(s), { state: 'working', tool: { name: 'Bash' }, since: T0 }, true);
  assert.equal(now.state, 'working');
  assert.equal(now.text, 'Merged Task 1');
});

test('working with a latest step that has no mapping says Working', () => {
  const s = orchestration().use('Read', { file_path: '/p/lib/y.js' });
  const parsed = parseOrchestrator(s.lines);
  const now = nowLine(parsed, stepsFor(s), { state: 'working', tool: null, since: T0 }, true);
  assert.equal(now.text, 'Working');
  assert.equal(now.detail, 'Read /p/lib/y.js');
});

test('with activity off, a live session uses the latest step', () => {
  const s = orchestration();
  const parsed = parseOrchestrator(s.lines);
  assert.equal(nowLine(parsed, stepsFor(s), null, true).text, 'Merged Task 1');
  s.text('All merged. Over to you.');
  const waiting = nowLine(parseOrchestrator(s.lines), stepsFor(s), null, true);
  assert.equal(waiting.text, 'Waiting for you');
  assert.equal(waiting.detail, 'All merged. Over to you.');
});

test('an ended orchestration that ran the finishing skill is Finished', () => {
  const s = orchestration().use('Skill', { skill: 'superpowers:finishing-a-development-branch' });
  const parsed = parseOrchestrator(s.lines);
  assert.equal(nowLine(parsed, stepsFor(s), null, false).state, 'finished');
  assert.equal(nowLine(parsed, stepsFor(s), null, false).text, 'Finished');
});

test('an ended orchestration without the finishing skill is Idle', () => {
  const s = orchestration();
  const now = nowLine(parseOrchestrator(s.lines), stepsFor(s), null, false);
  assert.equal(now.state, 'idle');
  assert.equal(now.text, 'Idle');
  assert.equal(now.since, null);
});
