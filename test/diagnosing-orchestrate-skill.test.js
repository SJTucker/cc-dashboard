'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'skills', 'diagnosing-orchestrate');
const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');

test('the frontmatter names the skill and keeps Claude from starting it', () => {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'frontmatter not found');
  assert.match(match[1], /^name: diagnosing-orchestrate$/m);
  assert.match(match[1], /^description: Use when an orchestrate run went wrong.+Also on "\/diagnosing-orchestrate \[image path or question\]"\.$/m);
  assert.match(match[1], /^disable-model-invocation: true$/m);
});

test('every file SKILL.md names exists', () => {
  const named = new Set(text.match(/(?:prompts|templates|references)\/[\w-]+\.md/g));
  assert.ok(named.size >= 9, [...named].join(', '));
  for (const f of named) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const f of ['scheduling', 'worker-stumbles', 'review-quality', 'steers-and-questions', 'cost-and-context', 'orchestrator-adherence', 'analyst-common']) {
    assert.ok(text.includes(`prompts/${f}.md`), f);
  }
});

test('the repo files the skill points at exist', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['docs/orchestrate-run-review.md', 'skills/orchestrate/SKILL.md', 'skills/orchestrate/image-template.md', 'skills/orch-plan/SKILL.md', 'bin/transcript-index', 'bin/orch-report', 'bin/orch-misses']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('the steps come in order', () => {
  const heads = ['## 1. Intake', '## 2. Locate', '## 3. Numbers', '## 4. Triage', '## 5. Report', '## Rules'];
  const at = heads.map((h) => text.indexOf(h));
  assert.ok(at.every((i) => i >= 0), at.join());
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at);
});

test('analysts run on Sonnet, in parallel, with absolute paths', () => {
  assert.ok(text.includes('model: "sonnet"'));
  assert.ok(text.includes('all at once'));
  assert.ok(text.includes('absolute'));
});

test('the rules keep the skill read-only and forbid raw transcript reads', () => {
  const rules = text.slice(text.indexOf('## Rules'));
  assert.ok(rules.includes('Read-only'));
  assert.ok(rules.includes('diagnosis-case.md') && rules.includes('diagnosis.md'));
  assert.ok(rules.includes('Never read a transcript raw'));
  assert.ok(rules.includes('proposes changes and makes none'));
  assert.ok(rules.includes("Only the owner's prompts count as the owner's words"));
  const common = fs.readFileSync(path.join(dir, 'prompts', 'analyst-common.md'), 'utf8');
  assert.ok(common.includes('Never\n   read a transcript raw'));
});

test('the dropped superpowers features are absent', () => {
  for (const s of ['GitHub issue', 'bundle', 'scrub', 'Red Flags']) assert.ok(!text.includes(s), s);
});

test('no file in the skill uses a ../ path', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) assert.ok(!fs.readFileSync(f, 'utf8').includes('../'), `${f} contains ../`);
});
