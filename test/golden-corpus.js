'use strict';

// A fixed set of transcripts for test/golden.test.js. Every branch of extractFile,
// aggregate and digestTranscript is reached by at least one line here. Timestamps
// are absolute, so the output does not depend on the day the test runs. Not a test
// file, so the test/*.test.js glob does not run it.

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Local midnight on 2026-10-08 in America/New_York, the zone test/golden.test.js
// sets. No daylight-saving change falls in the 40 days before it.
const MIDNIGHT = Date.parse('2026-10-08T00:00:00-04:00');
// The `now` every aggregate call in test/golden.test.js uses.
const NOW = MIDNIGHT + 12 * HOUR;

// An ISO timestamp `daysBack` local days before 2026-10-08, at hour:minute.
const at = (daysBack, hour, minute = 0) => new Date(MIDNIGHT - daysBack * DAY + hour * HOUR + minute * MIN).toISOString();

const SONNET = 'claude-sonnet-4-6-20260115';
const HAIKU = 'claude-haiku-4-5-20251001';
const OPUS = 'claude-opus-4-6-20260315';

const usage = (input, output, more = {}) => ({ input_tokens: input, output_tokens: output, ...more });

function typed(sessionId, text, timestamp, extra = {}) {
  return { type: 'user', sessionId, timestamp, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text }, ...extra };
}

// A user line that is neither a prompt nor a tool result. Used to carry gitBranch.
function meta(sessionId, timestamp, extra = {}) {
  return { type: 'user', sessionId, timestamp, isMeta: true, message: { role: 'user', content: 'meta' }, ...extra };
}

function assistant(sessionId, timestamp, { msg, req, model = SONNET, use, content = [], extra = {} }) {
  return { type: 'assistant', sessionId, timestamp, requestId: req, message: { id: msg, model, usage: use, content }, ...extra };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function toolResult(sessionId, timestamp, toolUseId, content, { isError = false, toolUseResult, extra = {} } = {}) {
  const line = { type: 'user', sessionId, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] }, ...extra };
  if (toolUseResult !== undefined) line.toolUseResult = toolUseResult;
  return line;
}

const CACHE = { cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 } };
const ON_MAIN = { gitBranch: 'main', version: '2.1.280' };

// The lines of response m-a1 and of the first tool results, which b.jsonl copies as
// a resumed session does.
function responseA1() {
  const s = 'sess-a';
  return [
    typed(s, '<pasted_content id="1">  a long pasted prompt that runs past the eighty character preview limit, so its title is cut  </pasted_content>', at(0, 9), { uuid: 'u-a1', ...ON_MAIN }),
    // One response over five lines: output grows 5, 5, 367, then a lower 100 and an
    // equal 367 do not replace it. The tool uses ride on the later lines.
    assistant(s, at(0, 9, 1), { msg: 'm-a1', req: 'r-a1', use: usage(1000, 5, CACHE), content: [{ type: 'text', text: 'Looking at the repo.' }], extra: { ...ON_MAIN, attributionSkill: 'tdd' } }),
    assistant(s, at(0, 9, 1), { msg: 'm-a1', req: 'r-a1', use: usage(1000, 5, CACHE), content: [toolUse('toolu_a1', 'Bash', { command: 'cd /repo && FOO=1 /usr/bin/git status' })], extra: { ...ON_MAIN, attributionSkill: 'tdd' } }),
    assistant(s, at(0, 9, 2), { msg: 'm-a1', req: 'r-a1', use: usage(1000, 367, CACHE), content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.js' } }], extra: { ...ON_MAIN, attributionSkill: 'tdd' } }),
    assistant(s, at(0, 9, 2), { msg: 'm-a1', req: 'r-a1', use: usage(1000, 100, CACHE), content: [null], extra: { ...ON_MAIN, attributionSkill: 'tdd' } }),
    // Ties the highest output. The marker shows the earlier line's usage is kept.
    assistant(s, at(0, 9, 2), { msg: 'm-a1', req: 'r-a1', use: usage(1000, 367, { ...CACHE, service_tier: 'tie-loses' }), extra: { ...ON_MAIN, attributionSkill: 'tdd' } }),
    toolResult(s, at(0, 9, 3), 'toolu_a1', 'Exit code 1\nfatal: not a git repository (or any of the parent directories): .git', { isError: true, extra: ON_MAIN }),
    assistant(s, at(0, 9, 4), {
      msg: 'm-a2',
      req: 'r-a2',
      use: usage(800, 120),
      content: [
        toolUse('toolu_a2', 'Edit', { file_path: '/repo/a.js' }),
        toolUse('toolu_a3', 'Write', { file_path: '/repo/new.txt' }),
        toolUse('toolu_a4', 'Write', { file_path: '/repo/empty.txt' }),
        toolUse('toolu_a5', 'Write', { file_path: '/repo/two.txt' }),
        toolUse('toolu_a6', 'Bash', { command: 'export X=1; sed -i s/a/b/ f' }),
        toolUse('toolu_a7', 'Edit', 'not an object'),
        toolUse('toolu_a8', 'Write', { file_path: '/repo/odd.txt' }),
      ],
      extra: ON_MAIN,
    }),
    toolResult(s, at(0, 9, 5), 'toolu_a2', [{ type: 'text', text: 'ok' }], { toolUseResult: { structuredPatch: [{ lines: ['+one', '+two', '-three', ' four', 5] }, { lines: null }, null] }, extra: ON_MAIN }),
  ];
}

function sessionA() {
  const s = 'sess-a';
  return [
    ...responseA1(),
    toolResult(s, at(0, 9, 5), 'toolu_a3', 'created', { toolUseResult: { type: 'create', content: 'x\ny\n' } }),
    toolResult(s, at(0, 9, 5), 'toolu_a4', 'created', { toolUseResult: { type: 'create', content: '' } }),
    toolResult(s, at(0, 9, 5), 'toolu_a5', 'created', { toolUseResult: { type: 'create', content: 'one\ntwo' } }),
    toolResult(s, at(0, 9, 6), 'toolu_a6', 'done', { toolUseResult: { bashEditDiff: { lines: ['+x'] } } }),
    toolResult(s, at(0, 9, 6), 'toolu_a7', 'no change', { toolUseResult: { structuredPatch: [] } }),
    toolResult(s, at(0, 9, 6), 'toolu_a8', 'odd', { toolUseResult: { type: 'create', content: 42 } }),
    // An edit result on a line whose content is not a tool_result block.
    meta(s, at(0, 9, 7), { toolUseResult: { structuredPatch: [{ lines: ['+lost'] }] } }),
    assistant(s, at(0, 10), {
      msg: 'm-a3',
      req: 'r-a3',
      use: usage(500, 40),
      content: [
        toolUse('toolu_a9', 'Edit', { file_path: '/repo/b.js' }),
        toolUse('toolu_a10', 'WebFetch', { url: 'https://example.com/page' }),
        toolUse('toolu_a11', 'WebFetch', { url: 'not a url' }),
        toolUse('toolu_a12', 'Agent', { subagent_type: 'Explore' }),
        toolUse('toolu_a13', 'Skill', { skill: 'tdd' }),
        { type: 'tool_use', id: 'toolu_a14', input: {} },
        toolUse('toolu_a15', 'Bash', { command: 'ls' }),
      ],
      extra: ON_MAIN,
    }),
    toolResult(s, at(0, 10, 1), 'toolu_a9', [{ type: 'text', text: 'String to replace not found in file /repo/b.js. ' + 'y'.repeat(400) }, null], { isError: true, toolUseResult: 'Error: String to replace not found', extra: ON_MAIN }),
    toolResult(s, at(0, 10, 1), 'toolu_a10', 'Permission for this action was denied by the auto mode classifier.', { isError: true }),
    toolResult(s, at(0, 10, 1), 'toolu_a11', "The user doesn't want to proceed with this tool use.", { isError: true }),
    toolResult(s, at(0, 10, 2), 'toolu_a12', 'z'.repeat(12000)),
    toolResult(s, at(0, 10, 2), 'toolu_a13', 'InputValidationError: skill not found', { isError: true }),
    toolResult(s, at(0, 10, 2), 'toolu_a14', 'Command blocked: isolated in the worktree', { isError: true }),
    toolResult(s, at(0, 10, 2), 'toolu_a15', 'ls: /tmp/x 12: No such file', { isError: true }),
    // A tool_result marked as an error with no tool_use_id makes no error row.
    { type: 'user', sessionId: s, timestamp: at(0, 10, 2), message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'orphan' }] } },
    { type: 'cost-state', sessionId: s, totalCostUSD: 1.5 },
    { type: 'cost-state', sessionId: s, totalCostUSD: 0.9 },
    { type: 'cost-state', sessionId: s, totalCostUSD: 'abc' },
    { type: 'ai-title', sessionId: s, aiTitle: 'First title' },
    { type: 'ai-title', sessionId: s, aiTitle: '   ' },
    { type: 'ai-title', sessionId: s, aiTitle: 7 },
    { type: 'system', subtype: 'compact_boundary', sessionId: s, timestamp: at(0, 10, 3) },
    { type: 'user', sessionId: s, timestamp: at(0, 10, 3), isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation so far.' } },
    typed(s, 'second prompt, queued', at(0, 10, 4), { promptSource: 'queued', ...ON_MAIN }),
    typed(s, '<command-name>/clear</command-name>', at(0, 10, 5)),
    typed(s, 'a meta line', at(0, 10, 5), { isMeta: true }),
    typed(s, 'typed with a bad timestamp', 'not-a-date'),
    typed(s, 'typed with no timestamp', undefined),
    { type: 'user', sessionId: s, timestamp: at(0, 10, 6), message: { role: 'user', content: 'an untagged prompt' } },
    { type: 'user', sessionId: s, timestamp: at(0, 10, 6), isSidechain: true, message: { role: 'user', content: 'a subagent task prompt' } },
    assistant(s, at(0, 11), { msg: 'm-syn', req: 'r-syn', model: '<synthetic>', use: usage(0, 0) }),
    assistant(s, 'garbage', { msg: 'm-bad', req: 'r-bad', use: usage(10, 10) }),
    assistant(s, undefined, { msg: 'm-nots', req: 'r-nots', use: usage(10, 10) }),
    assistant(s, at(0, 11), { msg: 'm-noin', req: 'r-noin', use: { output_tokens: 10 } }),
    // Two lines with no message id or requestId: each is its own call.
    assistant(s, at(0, 11, 1), { use: usage(30, 3), content: [toolUse(undefined, 'Bash', { command: 'ls' })] }),
    assistant(s, at(0, 11, 1), { use: usage(30, 3) }),
    assistant(s, at(0, 11, 2), { msg: 'm-gpt', req: 'r-gpt', model: 'gpt-4o', use: usage(400, 40) }),
    assistant(s, at(0, 11, 3), { msg: 'm-nomodel', req: 'r-nomodel', model: null, use: usage(20, 2) }),
    assistant(s, at(0, 11, 4), { msg: 'm-big', req: 'r-big', model: OPUS, use: usage(2000, 900, { cache_read_input_tokens: 160000 }), extra: { gitBranch: 'main', version: 2.1 } }),
    meta(s, at(0, 11, 5), { gitBranch: 'feature/x' }),
    // Same time as the line above: the later line is the newest branch.
    meta(s, at(0, 11, 5), { gitBranch: 'feature/x2' }),
    meta(s, at(0, 8), { gitBranch: 'early' }),
    meta(s, undefined, { gitBranch: 'no-time' }),
    meta(s, at(0, 11, 5), { gitBranch: '' }),
    {
      type: 'assistant',
      sessionId: s,
      timestamp: at(0, 11, 6),
      gitBranch: 'HEAD',
      isSidechain: true,
      requestId: 'r-sub',
      attributionAgent: 'Explore',
      message: { id: 'm-sub', model: HAIKU, usage: usage(300, 30), content: [{ type: 'text', text: 'subagent reply' }] },
    },
    { type: 'cost-state', sessionId: s, totalCostUSD: 2.25 },
    { type: 'ai-title', sessionId: s, aiTitle: '  Final title  ' },
    '{"broken',
    '   ',
  ];
}

// A resumed session: its file starts with lines copied from a.jsonl, which keep
// sess-a's ids, then adds its own.
function sessionB() {
  const s = 'sess-b';
  return [
    ...responseA1(),
    toolResult('sess-a', at(0, 9, 8), 'toolu_a1', 'Exit code 2\nfatal: a later copy of the error', { isError: true }),
    typed(s, 'pick up where we left off', at(3, 9), { uuid: 'u-b1', gitBranch: 'feature/y' }),
    assistant(s, at(3, 9, 1), { msg: 'm-b1', req: 'r-b1', use: usage(700, 70, CACHE), content: [{ type: 'text', text: 'Resuming.' }], extra: { gitBranch: 'feature/y', attributionSkill: 'review' } }),
    assistant(s, at(3, 14), { msg: 'm-b2', req: 'r-b2', model: HAIKU, use: usage(200, 20), extra: { gitBranch: 'main' } }),
    assistant(s, at(1, 23, 30), { msg: 'm-b3', req: 'r-b3', use: usage(100, 10), extra: { gitBranch: 'main' } }),
    { type: 'cost-state', sessionId: s, totalCostUSD: 0.5 },
    { type: 'cost-state', sessionId: 'sess-a', totalCostUSD: 3 },
    { type: 'ai-title', sessionId: s, aiTitle: 'Resumed work' },
    { type: 'ai-title', sessionId: 'sess-a', aiTitle: 'Title from b' },
    meta('sess-a', at(0, 11, 50), { gitBranch: 'feature/z' }),
    meta('sess-a', at(0, 7), { gitBranch: 'main' }),
  ];
}

// An old session. Every line is 40 days back, so a 30-day or 7-day scan reads no
// rows from it but still takes its title, branch and first prompt.
function sessionC() {
  const s = 'sess-c';
  return [
    typed(s, 'an old prompt', at(40, 10), { uuid: 'u-c1', gitBranch: 'old-branch' }),
    assistant(s, at(40, 10, 1), { msg: 'm-c1', req: 'r-c1', use: usage(900, 90), content: [toolUse('toolu_c1', 'Edit', { file_path: '/old/c.js' })], extra: { gitBranch: 'old-branch' } }),
    toolResult(s, at(40, 10, 2), 'toolu_c1', 'File has not been read yet', { isError: true }),
    toolResult(s, at(40, 10, 2), 'toolu_c1', 'ok', { toolUseResult: { structuredPatch: [{ lines: ['+c'] }] } }),
    { type: 'ai-title', sessionId: s, aiTitle: 'Old session' },
    { type: 'cost-state', sessionId: s, totalCostUSD: 0.75 },
  ];
}

// Lines with no sessionId, which are filed under the file path, and odd JSON values.
function sessionD() {
  return [
    { type: 'assistant', timestamp: at(10, 12), requestId: 'r-d1', message: { id: 'm-d1', model: SONNET, usage: usage(50, 5) } },
    { type: 'ai-title', aiTitle: 'No session id' },
    meta('constructor', at(10, 12, 1), { gitBranch: 'proto' }),
    assistant('constructor', at(10, 12, 2), { msg: 'm-d2', req: 'r-d2', use: usage(60, 6) }),
    [],
    42,
  ];
}

// Calls spread over days 10 and 5 back with idle days between, and an error and an
// edit with no timestamp, which are inside every range.
function sessionE() {
  const s = 'sess-e';
  return [
    assistant(s, at(10, 3), { msg: 'm-e1', req: 'r-e1', use: usage(110, 11), content: [toolUse('toolu_e1', 'Bash', { command: 'npm test' })] }),
    assistant(s, at(10, 23), { msg: 'm-e2', req: 'r-e2', use: usage(120, 12), content: [toolUse('toolu_e2', 'Edit', { file_path: '/e.js' })] }),
    assistant(s, at(5, 0, 30), { msg: 'm-e3', req: 'r-e3', use: usage(130, 13), content: [toolUse('toolu_e3', 'Bash', { command: 'npm run lint' }), toolUse('toolu_e4', 'Read', { file_path: '/e.md' })] }),
    toolResult(s, undefined, 'toolu_e1', 'Exit code 3\nnpm ERR! 7 failing', { isError: true }),
    // Same cause and message as toolu_e1's error, so the two share an error group.
    toolResult(s, at(5, 0, 31), 'toolu_e3', 'Exit code 3\nlint failed', { isError: true }),
    // The only error in its group, with no timestamp.
    toolResult(s, undefined, 'toolu_e4', 'File does not exist.', { isError: true }),
    toolResult(s, undefined, 'toolu_e2', 'ok', { toolUseResult: { structuredPatch: [{ lines: ['+e', '-f'] }] } }),
  ];
}

// Session summaries only: no row has a timestamp, so maxT is null.
function sessionF() {
  return [
    { type: 'cost-state', sessionId: 'sess-f', totalCostUSD: 0.1 },
    { type: 'ai-title', sessionId: 'sess-f', aiTitle: 'Titles only' },
  ];
}

// Lines only digestTranscript reads. A bare `null` line throws in extractFile, so
// this file is left out of the extract and aggregate goldens.
function digestOnly() {
  const s = 'sess-g';
  return [
    'null',
    typed(s, 'review me', at(0, 9)),
    { type: 'assistant', sessionId: s, message: { content: [toolUse('toolu_g1', 'Read', { file_path: '/g.js' }), toolUse('toolu_g1', 'Read', { file_path: '/g.js' })] } },
    { type: 'assistant', sessionId: s, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', input: {} }] } },
    { type: 'assistant', sessionId: s, message: { content: [{ type: 'text', text: '   ' }, { type: 'text', text: 5 }, null, { type: 'thinking', thinking: 'x' }] } },
    { type: 'assistant', sessionId: s, message: { content: 'a string reply' } },
    toolResult(s, at(0, 9, 1), 'toolu_unknown', 'failed', { isError: true }),
    toolResult(s, at(0, 9, 1), 'toolu_g1', 'short'),
    { type: 'user', sessionId: s, message: { content: [{ type: 'text', text: 'not a tool result' }] } },
    { type: 'assistant', sessionId: s, isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
  ];
}

const FILES = {
  'a.jsonl': sessionA,
  'b.jsonl': sessionB,
  'c.jsonl': sessionC,
  'd.jsonl': sessionD,
  'e.jsonl': sessionE,
  'f.jsonl': sessionF,
};

// Writes the corpus into `dir`. `shared` lists the files every golden reads, in walk
// order, ending with one that does not exist so a failed read is covered.
// `digestOnly` lists the files only the digest golden reads.
function writeCorpus(dir) {
  const write = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  for (const [name, build] of Object.entries(FILES)) write(name, build());
  write('g.jsonl', digestOnly());
  return { shared: [...Object.keys(FILES), 'missing.jsonl'], digestOnly: ['g.jsonl'] };
}

module.exports = { NOW, writeCorpus };
