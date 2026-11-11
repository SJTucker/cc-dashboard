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
  const now = nowLine(parsed, stepsFor(s), { state: 'working', tool: null, since: T0 }, true);
  assert.equal(now.state, 'working');
  assert.equal(now.text, 'Merged Task 1');
});

test('a latest SendMessage step reads Steered Task N with the summary', () => {
  const s = orchestration().use('SendMessage', { to: 'a1', summary: 'rebase first', message: 'long' });
  const parsed = parseOrchestrator(s.lines);
  const now = nowLine(parsed, stepsFor(s), { state: 'working', tool: null, since: T0 }, true);
  assert.equal(now.text, 'Steered Task 1');
  assert.equal(now.detail, 'rebase first');
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

test('nowLine reads the raw Monitor input, so the description wins over the command text', () => {
  const s = orchestration();
  const parsed = parseOrchestrator(s.lines);
  const steps = stepsFor(s);
  assert.equal(nowLine(parsed, steps, { state: 'working', tool: null, since: T0 }, true).text, 'Merged Task 1');
  s.use('Monitor', { description: 'watch Task 2 progress', command: 'tail -f board' });
  const again = parseOrchestrator(s.lines);
  assert.equal(nowLine(again, stepsFor(s), null, true, s.lines).text, 'Watching Task 2');
  assert.equal(nowLine(again, stepsFor(s), null, true).text, 'Watching workers', 'without the lines it still falls back to the step text');
});

test('nowLine finds a wt switch at the end of a very long Bash command', () => {
  const s = orchestration().use('Bash', { command: `echo ${'x'.repeat(600)}; wt switch --create demo-t7 --base demo --no-cd` });
  const now = nowLine(parseOrchestrator(s.lines), stepsFor(s), null, true, s.lines);
  assert.equal(now.text, 'Created worktree demo-t7');
});

test('nowLine falls back to the step text when the raw line cannot be read', () => {
  const s = orchestration().use('Bash', { command: 'wt switch --create demo-t8 --base demo --no-cd' });
  const lines = [...s.lines];
  lines[lines.length - 1] = '{broken';
  const now = nowLine(parseOrchestrator(s.lines), stepsFor(s), null, true, lines);
  assert.equal(now.text, 'Created worktree demo-t8');
});

test('a command that creates several worktrees reads Created worktrees a, b', () => {
  const s = orchestration().use('Bash', { command: 'wt switch --create demo-t2 --base demo --no-cd && wt switch --create demo-t3 --base demo --no-cd' });
  const { feed } = feedOf(s);
  assert.equal(feed[0].text, 'Created worktrees demo-t2, demo-t3');
});

test('a command that merges and creates gives a merge entry and a create entry at the same time', () => {
  const s = orchestration().use('Bash', { command: 'git merge demo-t2 && wt switch --create demo-t3 --base demo --no-cd' });
  const { feed } = feedOf(s);
  assert.deepEqual(feed.slice(0, 2).map((a) => a.text), ['Merged Task 2', 'Created worktree demo-t3']);
  assert.equal(feed[0].at, feed[1].at);
  const now = nowLine(parseOrchestrator(s.lines), stepsFor(s), null, true, s.lines);
  assert.equal(now.text, 'Merged Task 2');
});

test('a command with several merges reads Merged Tasks 1, 2, before its creates', () => {
  const s = new Script().prompt('go').use('Skill', { skill: 'orchestrate' });
  s.use('Bash', { command: 'wt switch --create demo --base main --no-cd' });
  s.use('Bash', { command: 'git merge demo-t1 && git merge demo-t2 && wt switch --create demo-t3 --base demo --no-cd' });
  const { feed } = feedOf(s);
  assert.deepEqual(feed.slice(0, 2).map((a) => a.text), ['Merged Tasks 1, 2', 'Created worktree demo-t3']);
});

test('each raw line is parsed once by the feed, though it holds two tool steps', () => {
  const s = new Script().prompt('go');
  s.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Skill', input: { skill: 'orchestrate' } }, { type: 'tool_use', id: 'x2', name: 'Skill', input: { skill: 'other' } }] } });
  const target = s.lines[1];
  const parsed = parseOrchestrator(s.lines);
  const countFor = (fn) => {
    let n = 0;
    const real = JSON.parse;
    JSON.parse = (text, ...rest) => {
      if (text === target) n++;
      return real(text, ...rest);
    };
    try {
      fn();
    } finally {
      JSON.parse = real;
    }
    return n;
  };
  const stepsOnly = countFor(() => stepsOf(s.lines, 1, s.lines.length));
  const whole = countFor(() => actionFeed(s.lines, parsed));
  assert.equal(whole - stepsOnly, 1);
});

test('a malformed raw line does not change the feed', () => {
  const clean = orchestration();
  const bad = orchestration();
  bad.lines.splice(4, 0, '{not json');
  const view = (s) => feedOf(s).feed.map((a) => [a.text, a.detail]);
  assert.deepEqual(view(bad), view(clean));
});

test('a user prompt in the feed is cut at 60 characters', () => {
  const s = orchestration();
  s.prompt('p'.repeat(100));
  const { feed } = feedOf(s);
  assert.equal(feed[0].text, `You: ${'p'.repeat(60)}`);
});

test('a Monitor whose description names no task reads Watching workers', () => {
  const s = orchestration().use('Monitor', { description: 'watch the board', command: 'tail -f b' });
  assert.equal(feedOf(s).feed[0].text, 'Watching workers');
});

test('a SendMessage to an agent that is not in the orchestration is left out of the feed', () => {
  const s = orchestration().use('SendMessage', { to: 'unknown', summary: 'hi', message: 'x' });
  const { feed } = feedOf(s);
  assert.equal(feed.length, 8);
  assert.ok(!feed.some((a) => a.detail === 'hi'));
});

const metaNote = (s, text) => s.push({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });

test('every dashboard steer note is a feed entry, with a task label or "a worker"', () => {
  const s = orchestration();
  metaNote(s, 'You steered Task 1 from the dashboard: rebase');
  metaNote(s, 'You steered a worker from the dashboard: look again');
  metaNote(s, 'You steered Task 9 from the dashboard: no worker for this');
  const { feed } = feedOf(s);
  assert.deepEqual(feed.slice(0, 3).map((a) => [a.text, a.detail]), [
    ['You steered Task 9', 'no worker for this'],
    ['You steered a worker', 'look again'],
    ['You steered Task 1', 'rebase'],
  ]);
  assert.equal(feed[0].glyph, '↗');
});
