'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AGENTS = path.join(__dirname, '..', 'agents');

// Splits an agent file into its frontmatter key/value pairs and its body.
function parse(name) {
  const lines = fs.readFileSync(path.join(AGENTS, name), 'utf8').split('\n');
  assert.strictEqual(lines[0], '---', `${name} must start with ---`);
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, `${name} has no closing ---`);
  const front = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(':');
    assert.ok(i > 0, `${name}: bad frontmatter line "${line}"`);
    front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { front, body: lines.slice(end + 1).join('\n').trim() };
}

const list = (s) => s.split(', ');

function checkBody(body) {
  assert.ok(body.length > 0);
  assert.ok(body.length < 1200, `body is ${body.length} characters`);
  assert.ok(!body.includes('<'), 'a < placeholder marks run-specific text');
}

test('orch-worker.md has the worker frontmatter and a short generic body', () => {
  const { front, body } = parse('orch-worker.md');
  assert.strictEqual(front.name, 'orch-worker');
  assert.strictEqual(front.model, 'sonnet');
  assert.deepStrictEqual(list(front.tools), ['Bash', 'Read', 'Edit', 'Write', 'Skill', 'TaskStop']);
  assert.ok(!('disallowedTools' in front));
  assert.ok(front.description.length > 0);
  checkBody(body);
});

test('orch-reviewer.md has the reviewer frontmatter and a short generic body', () => {
  const { front, body } = parse('orch-reviewer.md');
  assert.strictEqual(front.name, 'orch-reviewer');
  assert.strictEqual(front.model, 'sonnet');
  assert.deepStrictEqual(list(front.tools), ['Bash', 'Read', 'Skill', 'TaskStop']);
  assert.deepStrictEqual(list(front.disallowedTools), ['Edit', 'Write', 'NotebookEdit']);
  assert.ok(front.description.length > 0);
  checkBody(body);
});

test('orch-final-reviewer.md has the final reviewer frontmatter and a short generic body', () => {
  const { front, body } = parse('orch-final-reviewer.md');
  assert.strictEqual(front.name, 'orch-final-reviewer');
  assert.strictEqual(front.model, 'fable');
  // pr-review starts finding-verifier and ui-check, so this agent needs the Agent tool.
  assert.deepStrictEqual(list(front.tools), ['Bash', 'Read', 'Skill', 'Agent', 'TaskStop']);
  assert.deepStrictEqual(list(front.disallowedTools), ['Edit', 'Write', 'NotebookEdit']);
  assert.ok(front.description.length > 0);
  checkBody(body);
});

test('the three agent files exist and are the only files in agents/', () => {
  assert.deepStrictEqual(fs.readdirSync(AGENTS).sort(), ['orch-final-reviewer.md', 'orch-reviewer.md', 'orch-worker.md']);
});
