'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'skills', 'orch-grill');
const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');

test('the frontmatter names the skill', () => {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'frontmatter not found');
  assert.match(match[1], /^name: orch-grill$/m);
  assert.match(match[1], /^disable-model-invocation: true$/m);
});

test('no file in the skill uses a ../ path', () => {
  for (const file of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!body.includes('../'), `${file} contains ../`);
  }
});

test('the files the skill names sit beside it', () => {
  for (const file of ['round.html', 'GLOSSARY-FORMAT.md', 'ADR-FORMAT.md']) {
    assert.ok(text.includes(file), `SKILL.md does not name ${file}`);
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} is missing`);
  }
});

test('the skill has the uncertainty rule and the three piles', () => {
  for (const s of ['still unsure', 'my calls', 'The code answers it', 'Only the owner knows']) {
    assert.ok(text.includes(s), s);
  }
});

test('the skill states the calls data and comment formats', () => {
  for (const s of ['"calls"', 'C1 overrule:', '"by": "claude"', 'matches no line format']) {
    assert.ok(text.includes(s), s);
  }
});

test('the spec it writes has decisions and edge cases', () => {
  for (const s of ['docs/superpowers/specs/', '## Decisions', '## Edge cases', '## Glossary and ADRs', '**Plan branch:**', '/orch-plan']) {
    assert.ok(text.includes(s), s);
  }
});

test("the skill starts in the plan branch's worktree", () => {
  for (const s of ['git fetch origin', 'wt switch --create', '--no-cd', 'wt remove', "main checkout's", '(cd <worktree>']) {
    assert.ok(text.includes(s), s);
  }
});

test('the skill commits the glossary and ADRs on the plan branch', () => {
  for (const s of ['git -C', 'git add', 'git commit', 'no attribution trailer']) {
    assert.ok(text.includes(s), s);
  }
  assert.ok(!text.includes('before starting orchestrate'));
});

test('the skill reuses an existing plan branch', () => {
  const start = text.indexOf('## 1. Start in');
  const sec = text.slice(start, text.indexOf('## 2.'));
  assert.ok(sec.includes('wt switch <plan branch> --no-cd'), 'no switch without --create');
  assert.ok(sec.includes('already exists'), 'does not name the existing-branch case');
  assert.ok(sec.includes('wt list --format json'));
});

test('the skill escapes < inside grill-data', () => {
  assert.ok(text.includes('\\u003c'), 'no \\u003c rule');
});

test('SETUP.md lists git fetch origin for both planning skills', () => {
  const setup = fs.readFileSync(path.join(__dirname, '..', 'SETUP.md'), 'utf8');
  const net = setup.slice(setup.indexOf('Network and model use'));
  assert.ok(net.includes('git fetch origin'), 'no git fetch origin');
  assert.ok(/\*\*The `orch-plan` skill\*\*/.test(net), 'no orch-plan bullet');
});
