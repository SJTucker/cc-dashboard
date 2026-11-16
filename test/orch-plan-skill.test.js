'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'skills', 'orch-plan', 'SKILL.md'), 'utf8');

const LABELS = [
  '**Test command:**',
  '**Fails before, passes after:**',
  '**Done when:**',
  '**Report:**',
  '**Reviewer:**',
  '**Reads:**',
  '**User steps:**',
];

// The text from the `## <title>` heading to the next `## ` heading.
function section(title) {
  const start = text.indexOf(`\n## ${title}`);
  assert.ok(start >= 0, `section ${title} not found`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

// The reviewer rule, whitespace collapsed.
function reviewerRule(source) {
  const from = source.indexOf('Choose `opus` when');
  const endMark = 'Choose `sonnet` otherwise.';
  const to = source.indexOf(endMark, from);
  assert.ok(from >= 0 && to > from, 'reviewer rule not found');
  return source.slice(from, to + endMark.length).replace(/\s+/g, ' ');
}

test('the frontmatter names the skill', () => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter not found');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  assert.strictEqual(fields.name, 'orch-plan');
  assert.ok(fields.description);
  assert.ok(fields.description.includes('/orch-plan'));
});

test('the skill drops the upstream execution menu', () => {
  for (const gone of ['REQUIRED SUB-SKILL', 'Which execution approach', 'Subagent-driven', 'writing-plans skill', 'using-git-worktrees']) {
    assert.ok(!text.includes(gone), `still has ${gone}`);
  }
  assert.ok(text.includes('/plan-review'));
});

test('the skill lists the seven field labels', () => {
  const line = text.split('\n').find((l) => l.startsWith('Field labels:'));
  assert.ok(line, 'Field labels line not found');
  const items = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepStrictEqual(items, LABELS);
  assert.ok(text.includes('Consumes (existing code)'));
});

test("the reviewer rule matches orchestrate's", () => {
  const orchestrate = fs.readFileSync(path.join(root, 'skills', 'orchestrate', 'SKILL.md'), 'utf8');
  assert.strictEqual(reviewerRule(text), reviewerRule(orchestrate));
});

test('the plan header has a Dependencies section', () => {
  assert.ok(text.includes('## Dependencies'));
  assert.ok(text.includes('`signature`'));
  assert.ok(text.includes('`behaviour`'));
});

test('the self-review checks dependencies, test commands, reads and discovery', () => {
  const review = section('Self-Review');
  for (const word of ['Dependencies', 'Test commands', 'Reads', 'Discovery']) {
    assert.ok(review.includes(word), `Self-Review lacks ${word}`);
  }
});

test('the skill handles specs without the orch-grill sections', () => {
  for (const word of ['Edge cases', 'GLOSSARY.md', '_Avoid_', 'only when']) {
    assert.ok(text.includes(word), `lacks ${word}`);
  }
});

test('the skill sets no line-count limit', () => {
  assert.ok(!text.includes('4,000'));
  assert.ok(text.includes('No line-count limit applies to a task'));
});

test("step 2 of the worktree section reads the path from wt list", () => {
  const line = text.split('\n').find((l) => l.startsWith('2. When that branch has a worktree'));
  assert.ok(line, 'step 2 not found');
  assert.ok(line.includes('wt list --format json'));
});

test("the skill starts in the plan branch's worktree", () => {
  for (const word of ['git fetch origin', 'wt switch --create', '--no-cd', 'wt remove', "main checkout's", '**Plan branch:**', '(cd <worktree>']) {
    assert.ok(text.includes(word), `lacks ${word}`);
  }
});

test('orch-plan keeps steps after the last task under a ## heading', () => {
  assert.ok(text.replace(/\s+/g, ' ').includes('Steps after the last task that no worker does'));
});
