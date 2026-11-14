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

test('the skill names every orch-plan field label', () => {
  const plan = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orch-plan', 'SKILL.md'), 'utf8');
  const line = plan.split('\n').find((l) => l.startsWith('Field labels:'));
  assert.ok(line, 'Field labels: line not found');
  const labels = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.strictEqual(labels.length, 7);
  for (const label of labels) assert.ok(text.includes(label), label);
});

test('section 3 takes decisions from the spec and adds the glossary and ADRs', () => {
  const three = section(3);
  for (const s of ['Decisions', 'GLOSSARY.md', 'ADR']) assert.ok(three.includes(s), s);
});

test('section 3 keeps per-task reads out of the image', () => {
  const three = section(3);
  assert.ok(three.includes('**Reads:**'));
  assert.ok(three.includes('Read before starting'));
});

test('section 5 checks the fields instead of rewriting them', () => {
  const five = section(5);
  for (const s of ['**Test command:**', '**Done when:**', '## Dependencies', '**User steps:**']) {
    assert.ok(five.includes(s), s);
  }
});

test('section 5 keeps the rewrite for plans without the fields', () => {
  assert.ok(section(5).replace(/\s+/g, ' ').includes('revise the plan so every task includes'));
});

test('section 5 edits the plan only before the first dispatch', () => {
  assert.ok(section(5).replace(/\s+/g, ' ').includes('Edit the plan only before the first dispatch'));
});

test('section 6 takes doneWhen from the Done when field', () => {
  assert.ok(section(6).includes('**Done when:**'));
});

test('the image template names the glossary and the spec\'s decisions', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orchestrate', 'image-template.md'), 'utf8');
  assert.ok(template.includes('GLOSSARY.md'));
  assert.ok(template.includes('Decisions section'));
});
