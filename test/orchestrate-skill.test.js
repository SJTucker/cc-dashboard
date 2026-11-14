'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orchestrate', 'SKILL.md'), 'utf8');

// The text of section <n>, from its "## <n>." heading to the next "## " heading.
function section(n) {
  const start = text.indexOf(`\n## ${n}. `);
  assert.ok(start >= 0, `section ${n} not found`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

test('the skill starts implementers and reviewers as the agent types', () => {
  assert.ok(text.includes('subagent_type: "orch-worker"'));
  assert.ok(text.includes('orch-reviewer'));
  for (const n of [6, 11]) assert.ok(!section(n).includes('general-purpose'));
});

test('the worker message stays under 1,600 characters', () => {
  const after = text.slice(text.indexOf('Build the worker message once per session'));
  const match = after.match(/```\n([\s\S]*?)\n```/);
  assert.ok(match, 'worker message block not found');
  const message = match[1].replace(/<(image|CLAIM|run|POST|board)>/g, '');
  assert.ok(message.length < 1600, `${message.length} characters`);
  assert.ok(message.includes('what you tried'));
});

test('the skill says what to do when an agent type is missing', () => {
  const six = section(6);
  assert.ok(six.includes('orch-worker'));
  assert.ok(six.includes('bin/setup'));
});

test('the skill checks the plan branch after each merge', () => {
  assert.ok(section(12).includes('doneWhen'));
});

test('the skill says a run needs auto mode', () => {
  assert.ok(text.includes('auto mode'));
});

test('the skill defines EVENT and REPORT', () => {
  assert.match(text, /- `EVENT`: `<clone>\/bin\/orch-event`/);
  assert.match(text, /- `REPORT`: `<clone>\/bin\/orch-report`/);
});

test('the skill logs each orchestrator event', () => {
  for (const kind of ['ready', 'waiting', 'answered', 'steer', 'review-pass', 'review-fail', 'merged', 'dropped']) {
    assert.ok(text.includes(`EVENT <run> ${kind}`), kind);
  }
});

test('the feedback entry takes peak context and outside reads from the report', () => {
  assert.ok(section(13).includes('REPORT <image>'));
});

test('the skill squashes a task branch against its merge-base', () => {
  assert.ok(section(11).includes('git reset --soft $(git merge-base <plan branch>-t<N> <plan branch>)'));
  assert.doesNotMatch(text, /reset --soft\s+<plan branch>/);
  assert.doesNotMatch(text, /merge-base\s+HEAD/);
});

test('the plan gives each task a reviewer model', () => {
  const five = section(5).replace(/\s+/g, ' ');
  for (const s of ['**Reviewer:**', 'opus', 'sonnet', '300']) assert.ok(five.includes(s), s);
});

test('the skill reviews a task on its reviewer model, Sonnet when unset', () => {
  const eleven = section(11).replace(/\s+/g, ' ');
  assert.ok(eleven.includes("the task's `reviewer`"));
  assert.ok(eleven.includes('Sonnet when the task has none'));
  assert.ok(!eleven.includes('`subagent_type: "orch-reviewer"`, `model: "sonnet"`'));
});

test('the skill raises a large code diff to an Opus reviewer', () => {
  const eleven = section(11).replace(/\s+/g, ' ');
  assert.ok(eleven.includes('300'));
  assert.ok(eleven.includes("':(exclude)*.md'"));
});

test('the skill ends a run with a Fable review of the plan branch', () => {
  const fourteen = section(14).replace(/\s+/g, ' ');
  for (const s of ['pr-review', 'model: "fable"', 'subagent_type: "general-purpose"', '/code-review high', '"task": 0']) {
    assert.ok(fourteen.includes(s), s);
  }
});

test('the worker message signs board posts with the task title', () => {
  const after = text.slice(text.indexOf('Build the worker message once per session'));
  const message = after.match(/```\n([\s\S]*?)\n```/)[1];
  assert.ok(message.includes('--from "Task <N> (<title>)"'));
  assert.ok(message.includes('with <N> and <title> from the task orch-claim printed'));
});

test('the watch description names the task and its title', () => {
  assert.ok(section(7).includes('`worker <agentId> Task <N> (<title>)`'));
});

test('the skill names tasks with their titles when reporting', () => {
  const intro = text.slice(0, text.indexOf('\n## 1. ')).replace(/\s+/g, ' ');
  assert.ok(intro.includes('When a message to the user names a task, write `Task <N> (<title>)`, never the bare number.'));
});

test('the steer row shows the title form', () => {
  assert.ok(text.includes('`You steered Task <N> (<title>) from the dashboard: <text>`'));
});
