'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIndex, stepsOf, renderIndex, recentSteps, contextTokens, watchEvents } = require('../lib/transcript-index');

// Fixture lines in the shapes Claude Code writes. Each helper returns one JSON line.
let clock = 0;
function stamp() {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 8, 10, 0, clock)).toISOString();
}
function rec(obj) {
  return JSON.stringify({ sessionId: 's1', cwd: '/r', gitBranch: 'main', timestamp: stamp(), ...obj });
}
function typed(text, { uuid = 'u-' + text, parentUuid = 'p-' + text, extra = {} } = {}) {
  return rec({ type: 'user', uuid, parentUuid, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text }, ...extra });
}
function queued(text) {
  return rec({ type: 'attachment', uuid: 'q-' + text, attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: text } });
}
function tool(name, input, id = 'id-' + name) {
  return { type: 'tool_use', id, name, input };
}
function text(t) {
  return { type: 'text', text: t };
}
function assistant(blocks, extra = {}) {
  return rec({ type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra });
}
function toolResult(id, { isError = false, agentId, body = 'ok', extra = {} } = {}) {
  const r = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: isError }] }, ...extra };
  if (agentId) r.toolUseResult = { agentId, status: 'completed' };
  return rec(r);
}
function compact() {
  return rec({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
}
function coordinator(message, extra = {}) {
  const content = `The coordinator sent a message while you were working:\n${message}`;
  return rec({ type: 'user', isMeta: true, origin: { kind: 'coordinator' }, message: { role: 'user', content }, ...extra });
}
const META = JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's1' });
const WORKER = { agentId: 'w1', isSidechain: true };

test('splits turns at typed and mid-turn prompts with 1-based line ranges', () => {
  const lines = [META, typed('A'), assistant([text('hi')]), toolResult('x'), queued('B'), assistant([text('ok')])];
  const idx = buildIndex(lines);
  assert.deepEqual(idx.turns.map((t) => [t.n, t.startLine, t.endLine, t.prompt]), [[1, 2, 4, 'A'], [2, 5, 6, 'B']]);
  assert.equal(idx.lineCount, 6);
  assert.equal(idx.worker, false);
});

test('counts edits, reads, bash groups, skills and errors per turn', () => {
  const lines = [
    typed('go'),
    assistant([tool('Edit', { file_path: 'a.ts' }, 'e1'), tool('Write', { file_path: 'b.md' }, 'w1'), tool('Edit', { file_path: 'a.ts' }, 'e2')]),
    assistant([tool('Read', { file_path: 'c.ts' }, 'r1'), tool('Read', { file_path: 'c.ts' }, 'r2')]),
    assistant([tool('Bash', { command: 'pnpm vitest run f' }, 'b1'), tool('Bash', { command: 'cd /x && git status' }, 'b2'), tool('Bash', { command: 'cd /x && git status' }, 'b3')]),
    assistant([tool('Skill', { skill: 'superpowers:writing-plans' }, 's1')]),
    toolResult('b1', { isError: true, body: 'exit 1' }),
  ];
  const t = buildIndex(lines).turns[0];
  assert.deepEqual(t.edited, [['a.ts', 2], ['b.md', 1]]);
  assert.deepEqual(t.read, ['c.ts']);
  assert.deepEqual(t.commands, [['git status', 2], ['pnpm vitest', 1]]);
  assert.deepEqual(t.skills, ['superpowers:writing-plans']);
  assert.equal(t.errors, 1);
});

test('links an Agent call to its agentId from the tool result', () => {
  const lines = [
    typed('map it'),
    assistant([tool('Agent', { description: 'Map mod', subagent_type: 'Explore', model: 'sonnet', prompt: 'p' }, 'ag1')]),
    toolResult('ag1', { agentId: 'a9f6' }),
  ];
  const idx = buildIndex(lines);
  const t = idx.turns[0];
  assert.deepEqual(t.agents, [{ description: 'Map mod', type: 'Explore', model: 'sonnet', agentId: 'a9f6' }]);
  assert.equal(idx.agentCount, 1);
});

test('records compaction lines and skips sidechain and compact-summary lines', () => {
  const lines = [
    typed('A'),
    assistant([tool('Edit', { file_path: '/r/side.ts' })], { isSidechain: true }),
    assistant([tool('Edit', { file_path: '/r/a.ts' })]),
    compact(),
    typed('This session is being continued from a previous conversation', { extra: { isCompactSummary: true } }),
    typed('B', { extra: { isSidechain: true } }),
  ];
  const idx = buildIndex(lines);
  assert.deepEqual(idx.compactions, [4]);
  assert.equal(idx.turns.length, 1);
  assert.deepEqual(idx.turns[0].edited, [['/r/a.ts', 1]]);
  assert.equal(idx.turns[0].endLine, 6);
});

test('a line that is not JSON is skipped but still counted', () => {
  const lines = [typed('A'), assistant([text('working')]), '{"type":"assist'];
  const idx = buildIndex(lines);
  assert.equal(idx.lineCount, lines.length);
  assert.equal(idx.turns.at(-1).endLine, lines.length);
});

test('a worker transcript starts turns at the task prompt and at coordinator messages', () => {
  const lines = [
    rec({ type: 'user', ...WORKER, message: { role: 'user', content: 'Do task 3' } }),
    rec({ type: 'user', ...WORKER, isMeta: true, message: { role: 'user', content: '<system-reminder>handback</system-reminder>' } }),
    assistant([tool('Read', { file_path: '/r/x.ts' })], WORKER),
    toolResult('id-Read', { extra: WORKER }),
    assistant([text('reading more')], WORKER),
    coordinator('Stop after this.', WORKER),
    assistant([text('stopping')], WORKER),
  ];
  const idx = buildIndex(lines);
  assert.equal(idx.worker, true);
  assert.deepEqual(idx.turns.map((t) => [t.startLine, t.prompt]), [[1, 'Do task 3'], [6, 'Stop after this.']]);
});

test('a resubmitted prompt with the same parentUuid and no reply between starts no new turn', () => {
  const lines = [
    typed('fix it', { uuid: 'u1', parentUuid: 'p0' }),
    rec({ type: 'system', subtype: 'informational', content: 'note' }),
    typed('fix it', { uuid: 'u2', parentUuid: 'p0' }),
    assistant([text('on it')]),
  ];
  const idx = buildIndex(lines);
  assert.equal(idx.turns.length, 1);
  assert.equal(idx.turns[0].endLine, 4);
});

test('an edited resubmission with the same parentUuid starts its own turn, so the prompt sent is kept', () => {
  const lines = [
    typed('fix it', { uuid: 'u1', parentUuid: 'p0' }),
    typed('fix it, and add a test', { uuid: 'u2', parentUuid: 'p0' }),
    assistant([text('on it')]),
  ];
  assert.deepEqual(buildIndex(lines).turns.map((t) => t.prompt), ['fix it', 'fix it, and add a test']);
});

test("a worker's SubagentHandback report is its turn's last text", () => {
  const lines = [
    rec({ type: 'user', ...WORKER, message: { role: 'user', content: 'Do task 3' } }),
    assistant([text('thinking  out\n loud')], WORKER),
    assistant([tool('SubagentHandback', { message: 'Report:\n  done' })], WORKER),
  ];
  const workerIdx = buildIndex(lines);
  assert.equal(workerIdx.turns.at(-1).lastText, 'Report: done');
});

test('stepsOf marks a SubagentHandback text step with its tool name, so a watcher can tell the report from other text', () => {
  const lines = [
    rec({ type: 'user', ...WORKER, message: { role: 'user', content: 'Do task 3' } }),
    assistant([text('working')], WORKER),
    assistant([tool('SubagentHandback', { message: 'Report: done' })], WORKER),
  ];
  assert.deepEqual(stepsOf(lines, 1, 3).map((s) => [s.kind, s.tool, s.text]), [
    ['user', null, 'Do task 3'],
    ['text', null, 'working'],
    ['text', 'SubagentHandback', 'Report: done'],
  ]);
});

test('stepsOf gives typed steps with line numbers, tools, errors and coordinator messages', () => {
  const lines = [
    assistant([tool('Bash', { command: 'false' }, 'b1')]),
    typed('A'),
    assistant([tool('Edit', { file_path: '/r/a.ts' }, 'e1')]),
    toolResult('b1', { isError: true, body: 'exit 1' }),
    coordinator('Stop after this.'),
  ];
  assert.deepEqual(stepsOf(lines, 2, 5).map((s) => [s.line, s.kind, s.tool, s.text]), [
    [2, 'user', null, 'A'],
    [3, 'tool', 'Edit', '/r/a.ts'],
    [4, 'error', 'Bash', 'exit 1'],
    [5, 'msg', null, 'Stop after this.'],
  ]);
});

test('records the transcript a resumed session started from', () => {
  const resume =
    'Read /p/old.jsonl, the transcript of an earlier Claude Code session, to find what it was working on, and continue from where it stopped.\n\nTips:\n';
  const idx = buildIndex([typed(resume), assistant([text('reading')])]);
  assert.equal(idx.facts.resumedFrom, '/p/old.jsonl');
  assert.equal(buildIndex([typed('hello')]).facts.resumedFrom, null);
});

test('collects facts and docs written under docs/superpowers or .claude/handoffs', () => {
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'First title', sessionId: 's1' }),
    typed('plan it'),
    assistant([tool('Write', { file_path: '/r/docs/superpowers/plans/p.md' }, 'w1'), tool('Write', { file_path: '/r/src/x.ts' }, 'w2')]),
    assistant([tool('Write', { file_path: '/r/docs/superpowers/plans/p.md' }, 'w3')], { gitBranch: 'feature' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Second title', sessionId: 's1' }),
  ];
  const idx = buildIndex(lines);
  assert.equal(idx.facts.title, 'Second title');
  assert.equal(idx.facts.branch, 'feature');
  assert.equal(idx.facts.cwd, '/r');
  assert.equal(idx.facts.sessionId, 's1');
  assert.ok(idx.facts.startedAt < idx.facts.updatedAt);
  assert.deepEqual(idx.written, ['/r/docs/superpowers/plans/p.md']);
});

// A session with a title, a compaction, an Agent call and a doc written, for the
// renderIndex tests.
function sessionLines() {
  return [
    JSON.stringify({ type: 'ai-title', aiTitle: 'First title', sessionId: 's1' }),
    typed('Build the index'),
    assistant([tool('Edit', { file_path: '/r/a.ts' }, 'e1'), tool('Edit', { file_path: '/r/a.ts' }, 'e2'), tool('Write', { file_path: '/r/docs/superpowers/plans/p.md' }, 'w1')]),
    compact(),
    assistant([tool('Agent', { description: 'Map mod', subagent_type: 'Explore', model: 'sonnet' }, 'ag1')]),
    toolResult('ag1', { agentId: 'a9f6' }),
    assistant([text('Done.')]),
  ];
}

test('renders the title, the transcript path and the how-to-read commands', () => {
  const idx = buildIndex(sessionLines());
  const md = renderIndex(idx, '/p/s1.jsonl');
  assert.match(md, /^# Transcript index: First title\n/);
  assert.ok(md.includes("Transcript: '/p/s1.jsonl' (7 lines)"));
  assert.ok(md.includes("sed -n 'A,Bp' '/p/s1.jsonl' | cut -c1-400"));
  assert.ok(md.includes(`grep -n '"uuid":"<uuid>"' '/p/s1.jsonl'`));
  assert.ok(md.includes('## Turn 1 · lines 2–7 · '));
  const untitled = renderIndex(buildIndex([typed('Fix   the\nbug')]), '/p/s1.jsonl');
  assert.match(untitled, /^# Transcript index: Fix the bug\n/);
});

test('quotes a transcript path with a space or a single quote', () => {
  const idx = buildIndex(sessionLines());
  assert.ok(renderIndex(idx, "/p/it's here/s1.jsonl").includes(`'/p/it'\\''s here/s1.jsonl'`));
});

test('caps each turn: prompt 300 chars, reads 8 then +k more, bash groups 6', () => {
  const reads = Array.from({ length: 10 }, (_, i) => tool('Read', { file_path: `f${i + 1}` }, `r${i}`));
  const edits = Array.from({ length: 12 }, (_, i) => tool('Edit', { file_path: `e${i + 1}` }, `e${i}`));
  const bash = ['ls', 'pwd', 'git status', 'git diff', 'npm test', 'node -v', 'make all'].map((c, i) => tool('Bash', { command: c }, `b${i}`));
  const md = renderIndex(buildIndex([typed('x'.repeat(400)), assistant([...reads, ...edits, ...bash])]), '/p/s1.jsonl');
  assert.ok(md.includes('Read: f1, f2, f3, f4, f5, f6, f7, f8 (+2 more)'));
  const prompt = md.split('\n').find((l) => l.startsWith('Prompt: '));
  assert.equal(prompt.length, 'Prompt: '.length + 300);
  const edited = md.split('\n').find((l) => l.startsWith('Edited: '));
  assert.equal(edited.split(', ').length, 10);
  const commands = md.split('\n').find((l) => l.startsWith('Commands: '));
  assert.equal(commands.split(', ').length, 6);
});

test('lists a subagent with its transcript path', () => {
  const md = renderIndex(buildIndex(sessionLines()), '/p/s1.jsonl');
  assert.ok(md.includes('"Map mod" (Explore, sonnet): /p/s1/subagents/agent-a9f6.jsonl'));
});

test('overview carries the goal, compactions, top edited files and docs written', () => {
  const md = renderIndex(buildIndex(sessionLines()), '/p/s1.jsonl');
  const overview = md.slice(md.indexOf('## Overview'), md.indexOf('## Turn 1'));
  assert.ok(overview.includes('Goal: Build the index'));
  assert.ok(overview.includes('Turns: 1'));
  assert.ok(overview.includes('Compactions at lines: 4'));
  assert.ok(overview.includes('Most edited: /r/a.ts (2), /r/docs/superpowers/plans/p.md (1)'));
  assert.ok(overview.includes('Docs written: /r/docs/superpowers/plans/p.md'));
  assert.ok(overview.includes("Subagents: 1, transcripts in '/p/s1/subagents/'"));
});

test('names the resumed-from transcript and its index', () => {
  const resume = 'Read /p/old.jsonl, the transcript of an earlier Claude Code session, to find what it was working on.';
  const resumedIdx = buildIndex([typed(resume)]);
  assert.ok(renderIndex(resumedIdx, '/p/s2.jsonl', '/c/idx').includes("Resumed from: '/p/old.jsonl'; its index: /c/idx/old.md"));
  assert.ok(renderIndex(resumedIdx, '/p/s2.jsonl').includes("Resumed from: '/p/old.jsonl'\n"));
});

test('omits empty rows in a turn', () => {
  const onlyTextTurnMd = renderIndex(buildIndex([typed('hi'), assistant([text('Hello.')])]), '/p/s1.jsonl');
  for (const row of ['Agents:', 'Edited:', 'Read:', 'Commands:', 'Skills:', 'Tool errors:']) {
    assert.ok(!new RegExp(`^${row}`, 'm').test(onlyTextTurnMd), row);
  }
  assert.ok(onlyTextTurnMd.includes('Last reply: Hello.'));
});

// A worker transcript with a task, two reads, a failed command, a coordinator
// message, an edit and a final text, at fixed times, for the --steps helpers.
function at(s) {
  return { ...WORKER, timestamp: `2026-11-08T14:02:${s}.000Z` };
}
function withUsage(blocks, usage, s) {
  return rec({ type: 'assistant', ...at(s), message: { role: 'assistant', content: blocks, usage } });
}
function workerLines() {
  return [
    rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do task 3' } }),
    assistant([tool('Read', { file_path: '/r/spec.md' }, 'r1'), tool('Read', { file_path: '/r/a.ts' }, 'r2')], at('01')),
    toolResult('r1', { extra: at('02') }),
    withUsage([tool('Bash', { command: 'npm test' }, 'b1')], { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, '02'),
    toolResult('b1', { isError: true, body: 'exit 1', extra: at('03') }),
    coordinator('Stop after this.', at('05')),
    assistant([tool('Edit', { file_path: '/r/a.ts' }, 'e1')], at('09')),
    withUsage([text('Done; tests pass.')], { input_tokens: 1250, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }, '11'),
  ];
}

test('recentSteps gives the last n steps, oldest first, with line numbers and times', () => {
  assert.deepEqual(recentSteps(workerLines(), 2), ['7 14:02:09 Edit /r/a.ts', '8 14:02:11 TEXT Done; tests pass.']);
});

test('recentSteps shows an error result and a coordinator message', () => {
  const out = recentSteps(workerLines(), 10);
  assert.ok(out.includes('5 14:02:03 ERROR Bash: exit 1'), out.join('\n'));
  assert.ok(out.includes('6 14:02:05 MSG Stop after this.'), out.join('\n'));
  assert.equal(out[0], '1 14:02:00 USER Do task 3');
});

test('recentSteps puts each step on one line and cuts text at 160 and a tool argument at 120', () => {
  const long = 'word '.repeat(60);
  const lines = [
    rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do it' } }),
    assistant([text(`line one\n\n${long}`), tool('Bash', { command: 'x'.repeat(200) }, 'b1')], at('01')),
  ];
  const [, txt, bash] = recentSteps(lines, 3);
  assert.equal(txt, `2 14:02:01 TEXT ${`line one ${long}`.slice(0, 160)}`);
  assert.equal(bash, `2 14:02:01 Bash ${'x'.repeat(120)}`);
});

test('contextTokens sums input, cache read and cache creation of the last assistant record', () => {
  assert.equal(contextTokens(workerLines()), 41_250);
  assert.equal(contextTokens([rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do it' } })]), null);
});

// A worker that edits `file` `times` times after its task prompt.
function linesWithEdit(file, times = 1) {
  const edits = Array.from({ length: times }, (_, i) => assistant([tool('Edit', { file_path: file }, `e${i}`)], at('01')));
  return [rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do task 3' } }), ...edits];
}
const NO_LIMITS = { files: null, budget: null };

test('watchEvents reports an edit outside the task files once', () => {
  let r = watchEvents(linesWithEdit('/r/other.ts'), null, { files: ['/r/a.ts'], budget: null });
  assert.deepEqual(r.events, ['DRIFT edit outside task files: /r/other.ts']);
  r = watchEvents(linesWithEdit('/r/other.ts', 2), r.seen, { files: ['/r/a.ts'], budget: null });
  assert.deepEqual(r.events, []);
  assert.deepEqual(watchEvents(linesWithEdit('/r/other.ts'), null, NO_LIMITS).events, [], 'no file list, no drift');
});

test('watchEvents matches a task file given relative to the worktree', () => {
  assert.deepEqual(watchEvents(linesWithEdit('/wt/lib/a.js'), null, { files: ['lib/a.js'], budget: null }).events, []);
  assert.deepEqual(watchEvents(linesWithEdit('/wt/xlib/a.js'), null, { files: ['lib/a.js'], budget: null }).events, ['DRIFT edit outside task files: /wt/xlib/a.js']);
});

test('watchEvents reports three identical failures in a row once', () => {
  const fail = (i) => [assistant([tool('Bash', { command: 'npm test' }, `b${i}`)], at('02')), toolResult(`b${i}`, { isError: true, body: 'exit 1', extra: at('03') })];
  const task = rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do task 3' } });
  let r = watchEvents([task, ...fail(1), ...fail(2)], null, NO_LIMITS);
  assert.deepEqual(r.events, []);
  r = watchEvents([task, ...fail(1), ...fail(2), ...fail(3)], r.seen, NO_LIMITS);
  assert.deepEqual(r.events, ['STUCK Bash exit 1 failed 3 times in a row']);
  r = watchEvents([task, ...fail(1), ...fail(2), ...fail(3), ...fail(4)], r.seen, NO_LIMITS);
  assert.deepEqual(r.events, [], 'a fourth failure in the same run is not reported again');
});

test('watchEvents does not count failures with different text as one run', () => {
  const lines = [rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do task 3' } })];
  ['exit 1', 'exit 2', 'exit 1'].forEach((body, i) => {
    lines.push(assistant([tool('Bash', { command: 'npm test' }, `b${i}`)], at('02')), toolResult(`b${i}`, { isError: true, body, extra: at('03') }));
  });
  assert.deepEqual(watchEvents(lines, null, NO_LIMITS).events, []);
});

test('watchEvents reports the budget crossing once', () => {
  const lines = workerLines();
  assert.deepEqual(watchEvents(lines, null, { files: null, budget: 50_000 }).events.filter((e) => e.startsWith('BUDGET')), []);
  let r = watchEvents(lines.slice(0, 7), null, { files: null, budget: 41_000 });
  assert.deepEqual(r.events.filter((e) => e.startsWith('BUDGET')), []);
  r = watchEvents(lines, r.seen, { files: null, budget: 41_000 });
  assert.deepEqual(r.events, ['BUDGET context 41250 tokens, over 41000']);
  r = watchEvents([...lines, assistant([text('more')], at('12'))], r.seen, { files: null, budget: 41_000 });
  assert.deepEqual(r.events, []);
});

test('watchEvents reports a coordinator message with its line', () => {
  const r = watchEvents(workerLines(), null, NO_LIMITS);
  assert.deepEqual(r.events, ['MSG landed at line 6']);
  assert.equal(r.done, false);
});

test('watchEvents reports DONE on a SubagentHandback and sets done', () => {
  const lines = [...workerLines(), assistant([tool('SubagentHandback', { message: 'Report:\n  all done' }, 'h1')], at('12'))];
  let r = watchEvents(lines.slice(0, 7), null, NO_LIMITS);
  assert.equal(r.done, false);
  r = watchEvents(lines, r.seen, NO_LIMITS);
  assert.deepEqual(r.events, ['DONE Report: all done']);
  assert.equal(r.done, true);
});

test('watchEvents ends on the finished flag only after a poll with no new lines', () => {
  const opts = { ...NO_LIMITS, finished: true };
  let r = watchEvents(workerLines(), null, opts);
  assert.deepEqual(r.events, ['MSG landed at line 6']);
  assert.equal(r.done, false);
  r = watchEvents(workerLines(), r.seen, opts);
  assert.deepEqual(r.events, ['DONE Done; tests pass.']);
  assert.equal(r.done, true);
});

test('watchEvents waits again when lines arrive after the finished flag', () => {
  const opts = { ...NO_LIMITS, finished: true };
  let r = watchEvents(workerLines().slice(0, 7), null, opts);
  r = watchEvents(workerLines(), r.seen, opts);
  assert.equal(r.done, false, 'line 8 arrived after the flag');
  r = watchEvents(workerLines(), r.seen, opts);
  assert.deepEqual(r.events, ['DONE Done; tests pass.']);
});

// A steer sent while a worker runs is written as a queued_command attachment.
function steer(message, s) {
  return rec({ type: 'attachment', ...at(s), attachment: { type: 'queued_command', prompt: message, origin: { kind: 'coordinator' }, isMeta: true } });
}
function handback(message, s) {
  return assistant([tool('SubagentHandback', { message }, 'h' + s)], at(s));
}

test('a steer that lands mid-run is a msg step and a MSG event', () => {
  const lines = [...linesWithEdit('/r/a.ts'), steer('Stop after this file.', '04'), assistant([text('STEERED')], at('05'))];
  assert.deepEqual(stepsOf(lines, 3, 3).map((s) => [s.kind, s.text]), [['msg', 'Stop after this file.']]);
  assert.deepEqual(watchEvents(lines, null, NO_LIMITS).events, ['MSG landed at line 3']);
  assert.deepEqual(buildIndex(lines).turns.map((t) => t.startLine), [1, 3]);
});

test('watchEvents with sinceLine reports only events after that line', () => {
  const lines = [...workerLines(), handback('Report: done', '12')];
  const r = watchEvents(lines, null, { ...NO_LIMITS, sinceLine: 6 });
  assert.deepEqual(r.events, ['DONE Report: done']);
});

test('watchEvents follows a worker resumed after its report to its last report', () => {
  const lines = [...workerLines(), handback('first report', '12'), coordinator('Fix the test.', at('13')), handback('second report', '14')];
  assert.deepEqual(watchEvents(lines, null, NO_LIMITS).events, ['MSG landed at line 6', 'MSG landed at line 10', 'DONE second report']);
  const resumed = lines.slice(0, 10);
  const r = watchEvents(resumed, null, { ...NO_LIMITS, finished: true });
  assert.equal(r.done, false, 'a finished flag left from the first run does not end a resumed worker');
});

test('a task file entry ending in / covers every file under that folder', () => {
  const opts = { files: ['lib/a.js', '/tmp/scratch/', 'docs/superpowers/'], budget: null };
  for (const file of ['/tmp/scratch/x.js', '/wt/docs/superpowers/plans/p.md']) {
    assert.deepEqual(watchEvents(linesWithEdit(file), null, opts).events, [], file);
  }
  assert.deepEqual(watchEvents(linesWithEdit('/tmp/scratchy/x.js'), null, opts).events, ['DRIFT edit outside task files: /tmp/scratchy/x.js']);
});

test('recentSteps with full keeps a whole command on one line', () => {
  const lines = [
    rec({ type: 'user', ...at('00'), message: { role: 'user', content: 'Do it' } }),
    assistant([tool('Bash', { command: `cd /r &&\n${'x'.repeat(200)} && npm test` }, 'b1')], at('01')),
  ];
  assert.equal(recentSteps(lines, 1, { full: true })[0], `2 14:02:01 Bash cd /r && ${'x'.repeat(200)} && npm test`);
});

test('recentSteps labels a SubagentHandback as REPORT', () => {
  const lines = [...workerLines(), assistant([tool('SubagentHandback', { message: 'Report:\n done' }, 'h1')], at('12'))];
  assert.equal(recentSteps(lines, 1)[0], '9 14:02:12 REPORT Report: done');
});
