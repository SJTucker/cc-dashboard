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
  for (const s of ['pr-review', 'model: "fable"', 'subagent_type: "orch-final-reviewer"', '/code-review high', '"fix": "final-review"']) {
    assert.ok(fourteen.includes(s), s);
  }
  assert.ok(!fourteen.includes('subagent_type: "general-purpose"'));
});

test('the skill logs the final review and runs the misses report', () => {
  const fourteen = section(14).replace(/\s+/g, ' ');
  assert.ok(fourteen.includes('EVENT <run> final-review --agent'));
  assert.ok(fourteen.includes('MISSES <image> --branch <plan branch> --base <base>'));
  assert.ok(!fourteen.includes('no row for the final review agent'));
  assert.match(text, /- `MISSES`: `<clone>\/bin\/orch-misses`/);
});

test('fix tasks for the leftovers start before the Fable review', () => {
  assert.ok(section(11).includes('<leftovers>'));
  const fourteen = section(14).replace(/\s+/g, ' ');
  const fable = fourteen.indexOf('model: "fable"');
  assert.ok(fourteen.indexOf('"fix": "leftovers"') >= 0);
  assert.ok(fourteen.indexOf('"fix": "leftovers"') < fable);
  assert.ok(fourteen.lastIndexOf('"fix": "final-review"') > fable);
  assert.ok(fourteen.includes('cites no file'));
  assert.ok(!fourteen.includes('`model: "opus"`'));
});

test('the skill logs relayed review findings as review-fix', () => {
  assert.ok(section(11).includes('review-fix --task <N>'));
  assert.ok(section(11).replace(/\s+/g, ' ').includes('merge only after its re-review passes'));
  assert.ok(section(10).includes('steer --task <N>'));
});

test('section 11 re-reviews a fix', () => {
  const eleven = section(11).replace(/\s+/g, ' ');
  assert.ok(eleven.includes('the task passes only on a new review'));
  assert.ok(eleven.includes('git -C <worktree> rev-parse HEAD'));
  assert.ok(eleven.includes('Re-review of commits <recorded head>..HEAD only'));
  assert.ok(eleven.includes("put the commit ids from the worker's report in"));
  assert.ok(eleven.includes('merge only after its re-review passes'));
  assert.ok(!eleven.includes('merge only after the worker reports its commit'));
});

test('section 11 starts reviewers without a watch', () => {
  const eleven = section(11).replace(/\s+/g, ' ');
  assert.ok(eleven.includes('Arm no section 7 watch for a reviewer'));
  assert.ok(eleven.includes("grep -o 'CLAIMED [0-9]*-t[0-9]*-a[0-9]*\\.json'"));
});

test('the worker and reviewer messages are unchanged', () => {
  const crypto = require('crypto');
  const block = (marker) => text.slice(text.indexOf(marker)).match(/```\n([\s\S]*?)\n```/)[1];
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  assert.strictEqual(sha(block('Build the worker message once per session')), 'a9324d43cb6fc7ba5a6631b134ac8e362d698108195c56d1ad475ad2dbb7472f');
  assert.strictEqual(sha(block('Build the reviewer message once per session')), '8d83e2ef1ef59527a2acbc2dbf26b23ea4f5c4b7cda64ee61529cba5ca2ad817');
});

test('the run review doc reads review fixes and the 5-minute cache', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'orchestrate-run-review.md'), 'utf8');
  for (const s of ['Review fixes:', 'fix: "final-review"', '5 minutes']) assert.ok(doc.includes(s), s);
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

test('the skill names every orch-plan field label', () => {
  const plan = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orch-plan', 'SKILL.md'), 'utf8');
  const line = plan.split('\n').find((l) => l.startsWith('Field labels:'));
  assert.ok(line, 'Field labels: line not found');
  const labels = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.strictEqual(labels.length, 8);
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

test('the run review doc names only bin tools that exist', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'orchestrate-run-review.md'), 'utf8');
  const names = [...new Set([...doc.matchAll(/bin\/([\w-]+)/g)].map((m) => m[1]))];
  assert.ok(names.includes('orch-report'));
  assert.ok(names.includes('orch-misses'));
  for (const name of names) {
    const file = path.join(__dirname, '..', 'bin', name);
    assert.ok(fs.statSync(file).isFile(), `bin/${name} is not a file`);
    fs.accessSync(file, fs.constants.X_OK);
  }
});

test('section 3 names the plan reads setting and leaves the plan out with sections', () => {
  const three = section(3);
  assert.ok(three.includes('Plan reads'));
  assert.ok(three.includes('sections'));
});

test('section 6 adds reads to work tasks only', () => {
  const six = section(6);
  assert.ok(six.includes('"reads": "sections"'));
  assert.ok(six.includes('Review tasks never carry'));
});

test('section 11 keeps the plan excerpt out of review tasks', () => {
  assert.ok(section(11).includes('planExcerpt'));
});

test('the image template records plan reads', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orchestrate', 'image-template.md'), 'utf8');
  assert.ok(template.includes('Plan reads:'));
});

test('the worker message is unchanged by plan reads', () => {
  const after = text.slice(text.indexOf('Build the worker message once per session'));
  const match = after.match(/```\n([\s\S]*?)\n```/);
  assert.ok(match, 'worker message block not found');
  assert.ok(!match[1].includes('sections'));
});

test('section 3 makes sections the default and checks the plan', () => {
  const three = section(3).replace(/\s+/g, ' ');
  assert.ok(three.includes('--check-plan'));
  assert.ok(three.includes('rename it to ## '));
  assert.ok(three.includes('Plan reads: whole ('));
  assert.ok(!three.includes('`whole` by default'));
});

test('section 6 rechecks the plan and adds a task the plan cannot cut without reads', () => {
  const six = section(6).replace(/\s+/g, ' ');
  assert.ok(six.includes('--check-plan'));
  assert.ok(six.includes('with no `reads`'));
  assert.ok(six.includes('the line ranges of the plan\'s Global Constraints, Review Focus and Dependencies sections and of its task section'));
  assert.ok(!six.includes('or run with `whole`'));
});

test('the image template defaults plan reads to sections', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orchestrate', 'image-template.md'), 'utf8');
  assert.ok(template.includes('- Plan reads: sections'));
});

test('section 3 says what to do with sections --check-plan lists as in no excerpt', () => {
  const three = section(3).replace(/\s+/g, ' ');
  assert.ok(three.includes('Not in any excerpt'));
  assert.ok(three.includes('copy that text into the image'));
  assert.ok(three.includes('## Final checks'));
});

test('section 3 and the image template list the plan in Read before starting only with whole', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orchestrate', 'image-template.md'), 'utf8');
  // The Sources comment lists the plan for every run, so only the Read before starting comment is checked.
  const reads = template.slice(template.indexOf('## Read before starting'), template.indexOf('## Decisions')).replace(/\s+/g, ' ');
  const three = section(3).replace(/\s+/g, ' ');
  for (const t of [three, reads]) {
    assert.ok(!t.includes('the spec, the plan,'));
    assert.ok(t.includes('the plan only when plan reads is `whole`'));
  }
});

test('a renumber or repeated-task refusal sends the plan back for renumbering, not to whole', () => {
  const three = section(3).replace(/\s+/g, ' ');
  assert.ok(three.includes('When stderr says `renumber` or `appears more than once`, renumber the plan\'s tasks and run the check again'));
  assert.ok(three.includes('`rename them to`'));
  const six = section(6).replace(/\s+/g, ' ');
  assert.ok(six.includes('Only a failure the plan cannot be fixed for (a missing shared section, a task over the limit) switches the run to `whole`'));
  assert.ok(!six.includes('exit 1, switch the run to `whole`'));
});

test('tasks that share only Markdown files may run at once, and the merge resolves the conflict', () => {
  assert.ok(section(5).replace(/\s+/g, ' ').includes('Two running tasks never share a code file'));
  assert.ok(section(11).replace(/\s+/g, ' ').includes('A conflict in a Markdown or other prose-only file counts as trivial'));
});

test('section 5 records the start commit', () => {
  const five = section(5).replace(/\s+/g, ' ');
  assert.ok(five.includes('<run>/start-commit'));
  assert.ok(five.includes('git rev-parse --verify <plan branch>^{commit} > <run>/start-commit'));
});

test('section 14 reviews from the start commit', () => {
  const fourteen = section(14).replace(/\s+/g, ' ');
  for (const s of ['the base is `<start>`', '`/code-review high` on `<start>...<plan branch>`', '`<run>/start-commit`', 'uses `<base>`']) {
    assert.ok(fourteen.includes(s), s);
  }
});

test('section 14 bounds dropped findings', () => {
  const fourteen = section(14).replace(/\s+/g, ' ');
  assert.ok(fourteen.includes('already records that choice'));
  assert.ok(fourteen.includes('with the line of the decision it rests on'));
});

test('section 14 has a stopped run', () => {
  const fourteen = section(14).replace(/\s+/g, ' ');
  for (const s of ['When the user stops the run', 'stopped by the user', 'rule does not apply to a stopped run', 'Remove no worktree and delete no branch unless the user asks']) {
    assert.ok(fourteen.includes(s), s);
  }
});

test('the orchestrator reads worker files with grep or git diff', () => {
  assert.ok(text.replace(/\s+/g, ' ').includes("Look at a worker's files with `grep -n` or `cd <worktree> && git diff`, not Read or Edit"));
});

test("section 5 decides choices inside the task's files", () => {
  const five = section(5).replace(/\s+/g, ' ');
  for (const s of ['look up each fact the code can settle', "changes only files in the asking task's", 'a change to the plan itself (section 9) still go to the user', 'with your recommendation in the question']) {
    assert.ok(five.includes(s), s);
  }
});

test('tasks written during a run list tests and importers', () => {
  assert.ok(section(6).replace(/\s+/g, ' ').includes('the test files that cover each file it changes and the files that import it'));
  assert.ok(section(14).replace(/\s+/g, ' ').includes('with their tests and importers (section 6)'));
});

test('the image template asks for hook deny rules', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'skills', 'orchestrate', 'image-template.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(tpl.includes('each hook that denies Bash commands in this project'));
  assert.ok(tpl.includes('the command to use instead'));
});

test('section 12 runs the browser check after merge', () => {
  const s12 = section(12);
  assert.ok(s12.includes('**Browser check:**'));
  assert.ok(s12.includes('ui-check'));
  assert.ok(s12.includes('run_in_background'));
  assert.ok(s12.includes('model: "sonnet"'));
});

test('section 12 holds dependents of a browser-checked task and runs one check at a time', () => {
  const s = section(12).replace(/\s+/g, ' ');
  assert.ok(s.includes('Hold each task that consumes from the merged task until its browser check passes, and dispatch only the other ready tasks meanwhile.'));
  assert.ok(s.includes('Run one browser check at a time. When another merged task has a browser check while one is running, start it after the first one reports and its server stops.'));
});

test('section 11 recovers a reviewer that returns no review', () => {
  const s = section(11).replace(/\s+/g, ' ');
  assert.ok(s.includes("When a reviewer's completion notification carries no review, run `TI <reviewer transcript> --steps 20` and apply section 8's `KILLED` or `FAILED` rule to the reviewer as to a worker."));
});

test('section 11 ends the fix-task loop after a passing re-review', () => {
  const s = section(11).replace(/\s+/g, ' ');
  assert.ok(s.includes('A re-review that passes ends the loop: merge the task, and list any problems that re-review names to the user in section 14, step 4.'));
});

test('section 5 keeps interface choices with the user', () => {
  const s = section(5).replace(/\s+/g, ' ');
  assert.ok(s.includes("and no option changes a name or behaviour in a plan's `Produces` or `Consumes` block, decide it"));
});
