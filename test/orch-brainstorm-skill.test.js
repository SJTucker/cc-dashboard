'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'skills', 'orch-brainstorm');
const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');

test('the frontmatter names the skill and lets Claude start it', () => {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'frontmatter not found');
  assert.match(match[1], /^name: orch-brainstorm$/m);
  assert.match(match[1], /^description: .+/m);
  assert.doesNotMatch(match[1], /disable-model-invocation/);
});

test('no file in the skill uses a ../ path', () => {
  for (const file of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!body.includes('../'), `${file} contains ../`);
  }
});

test('the builder check prompt sits beside the skill and the visual companion is gone', () => {
  assert.ok(text.includes('builder-check-prompt.md'));
  assert.ok(fs.existsSync(path.join(dir, 'builder-check-prompt.md')));
  assert.ok(!text.includes('visual-companion.md'));
  assert.ok(!fs.existsSync(path.join(dir, 'visual-companion.md')));
  assert.ok(!text.includes('scripts/'));
  assert.ok(!fs.existsSync(path.join(dir, 'scripts')));
});

test('the skill never invokes writing-plans and hands off to /orch-plan', () => {
  for (const line of text.split('\n').filter((l) => l.includes('writing-plans'))) {
    assert.ok(line.includes('Do not invoke'), line);
  }
  assert.ok(text.includes('/orch-plan'));
});

test('the spec it writes is untracked and has decisions and edge cases', () => {
  for (const s of ['docs/superpowers/specs/', 'untracked', '## Decisions', '## Edge cases']) {
    assert.ok(text.includes(s), s);
  }
});

test('the skill starts no local server', () => {
  assert.ok(!text.includes('start-server'));
  assert.ok(!text.includes('localhost'));
});
