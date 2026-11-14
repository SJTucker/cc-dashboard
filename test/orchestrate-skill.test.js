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
  assert.ok(!text.includes('general-purpose'));
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

test('the skill squashes a task branch against its merge-base', () => {
  assert.ok(section(11).includes('git reset --soft $(git merge-base <plan branch>-t<N> <plan branch>)'));
  assert.doesNotMatch(text, /reset --soft\s+<plan branch>/);
});
