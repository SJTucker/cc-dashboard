'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planSections, sharedHeadings, planTasks, otherSections } = require('../lib/orchestrations/plan-sections');

function plan(task1Body = 'Body one.') {
  return [
    '# Title Plan',
    '',
    'Header paragraph.',
    '',
    '## Global Constraints',
    '',
    '- constraint',
    '',
    '## Review Focus',
    '',
    '1. focus',
    '',
    '## Dependencies',
    '',
    '- Task 1: nothing',
    '',
    '---',
    '',
    '### Task 1: One',
    '',
    task1Body,
    '',
    '---',
    '',
    '### Task 2: Two',
    '',
    'Body two.',
    '',
    '### Task 10: Ten',
    '',
    'Body ten.',
    '',
  ].join('\n');
}

test('returns the shared sections then the task\'s own section', () => {
  const out = planSections(plan(), 2);
  assert.ok(out.startsWith('## Global Constraints'));
  const iFocus = out.indexOf('## Review Focus');
  const iDeps = out.indexOf('## Dependencies');
  const iTask = out.indexOf('### Task 2: Two');
  assert.ok(iFocus > 0 && iDeps > iFocus && iTask > iDeps);
  assert.ok(!out.includes('### Task 1:'));
  assert.ok(!out.includes('Header paragraph'));
  assert.ok(!out.includes('---'));
});

test('Task 1 does not match Task 10', () => {
  const out = planSections(plan(), 1);
  assert.ok(out.includes('### Task 1: One'));
  assert.ok(!out.includes('### Task 10'));
});

test('a heading inside a code fence does not end the section', () => {
  const body = ['```markdown', '## Not a heading', '### Task 2: fake', '```', 'text after the fence'].join('\n');
  const out = planSections(plan(body), 1);
  assert.ok(out.includes('## Not a heading'));
  assert.ok(out.includes('### Task 2: fake'));
  assert.ok(out.includes('text after the fence'));
  assert.ok(!out.includes('Body two.'));
});

test('task 0 gets the shared sections only', () => {
  const out = planSections(plan(), 0);
  assert.ok(out.includes('## Dependencies'));
  assert.ok(!out.includes('### Task'));
});

test('a missing task section gives null', () => {
  assert.strictEqual(planSections(plan(), 7), null);
});

test('a plan without shared sections gives the task section alone', () => {
  const text = '### Task 1: One\n\nBody one.\n';
  assert.strictEqual(planSections(text, 1), '### Task 1: One\n\nBody one.');
});

test('a four-backtick fence holding a three-backtick fence stays one fence', () => {
  const body = ['````markdown', '```markdown', '## Inner heading', '```', '````', 'after the fence'].join('\n');
  const out = planSections(plan(body), 1);
  assert.ok(out.includes('## Inner heading'));
  assert.ok(out.includes('after the fence'));
});

test('a subheading inside a shared section does not end it', () => {
  const text = plan().replace('- Task 1: nothing', '### Shared files\n\nline after it');
  const out = planSections(text, 2);
  assert.ok(out.includes('### Shared files'));
  assert.ok(out.includes('line after it'));
});

test('a plan with nothing to cut gives null', () => {
  assert.strictEqual(planSections('# Title\n\ntext', 0), null);
});

test('a prose line starting with an inline code span of backticks does not open a fence', () => {
  const body = '```markdown``` fence is shown below.\n\nStill Task 1.';
  const out = planSections(plan(body), 1);
  assert.ok(out.includes('Still Task 1.'));
  assert.ok(!out.includes('### Task 2'));
  assert.ok(planSections(plan(body), 2).includes('### Task 2: Two'));
});

test('a ### subheading or --- rule inside a task keeps the rest of the task', () => {
  const body = 'step 1\n\n### Notes\n\nnote text\n\n---\n\nstep 2';
  const out = planSections(plan(body), 1);
  assert.ok(out.includes('note text'));
  assert.ok(out.includes('step 2'));
  assert.ok(!out.includes('### Task 2:'));
});

test('a --- rule inside a shared section keeps the text after it', () => {
  const text = plan().replace('- constraint', '- a\n\n---\n\n- b after rule');
  assert.ok(planSections(text, 1).includes('- b after rule'));
});

test('the rule between sections is not in the excerpt', () => {
  const out = planSections(plan(), 1);
  assert.ok(!out.split('\n').some((l) => l === '---'));
});

test('a # heading ends a task section', () => {
  const text = plan() + '\n# Appendix\n\nappendix text\n';
  assert.ok(!planSections(text, 10).includes('appendix text'));
});

test('a CRLF plan gives the same excerpt as the LF plan', () => {
  assert.strictEqual(planSections(plan().replace(/\n/g, '\r\n'), 2), planSections(plan(), 2));
});

test('sharedHeadings finds missing and miscased shared headings', () => {
  assert.deepStrictEqual(sharedHeadings(plan()), { missing: [], miscased: [] });
  const lower = plan().replace('## Global Constraints', '## Global constraints').replace('## Dependencies', '');
  assert.deepStrictEqual(sharedHeadings(lower), { missing: ['Global Constraints'], miscased: ['Global Constraints'] });
  const dep = plan().replace('## Dependencies', '## dependencies');
  assert.deepStrictEqual(sharedHeadings(dep), { missing: [], miscased: ['Dependencies'] });
  const fenced = plan().replace('## Review Focus', '```\n## Review Focus\n```');
  assert.ok(sharedHeadings(fenced).missing.includes('Review Focus'));
  const trailing = plan().replace('## Review Focus', '## Review Focus ');
  assert.deepStrictEqual(sharedHeadings(trailing), { missing: [], miscased: [] });
});

test('planTasks lists task headings outside fences in plan order', () => {
  assert.deepStrictEqual(planTasks(plan()), [1, 2, 10]);
  assert.deepStrictEqual(planTasks(plan('```\n### Task 5: Example\n```')), [1, 2, 10]);
});

test('sharedHeadings counts a shared heading with a suffix as miscased', () => {
  const dep = plan().replace('## Dependencies', '## Dependencies:');
  assert.deepStrictEqual(sharedHeadings(dep), { missing: [], miscased: ['Dependencies'] });
  const gc = plan().replace('## Global Constraints', '## Global Constraints (all tasks)');
  assert.deepStrictEqual(sharedHeadings(gc), { missing: ['Global Constraints'], miscased: ['Global Constraints'] });
  const lower = plan().replace('## Review Focus', '## review focus areas');
  assert.deepStrictEqual(sharedHeadings(lower), { missing: ['Review Focus'], miscased: ['Review Focus'] });
});

test('otherSections lists the ## headings outside fences that no excerpt carries', () => {
  assert.deepStrictEqual(otherSections(plan()), []);
  const text = plan()
    .replace('## Global Constraints', '## Before you start\n\nread this\n\n## Global Constraints')
    .replace('### Task 2: Two', '## Stage 2: charts\n\n```\n## Fenced\n```\n\n### Task 2: Two');
  assert.deepStrictEqual(otherSections(text + '\n## Appendix \n\ntext\n'), ['## Before you start', '## Stage 2: charts', '## Appendix']);
});

test('otherSections lists a shared heading that repeats after its first occurrence', () => {
  const text = plan() + '\n## Global Constraints\n\nmore rules\n';
  assert.deepStrictEqual(otherSections(text), ['## Global Constraints']);
  assert.ok(!planSections(text, 1).includes('more rules'));
});
