'use strict';

const fs = require('fs');
const readline = require('readline');

// Bump when extractFile starts producing different rows. A file still on disk with
// an older version is re-extracted. Rows whose transcript is gone are upgraded by a
// migration in lib/store.js instead.
const EXTRACT_VERSION = 1;

// The second level of the tool breakdown: the one input field that groups a tool's
// calls usefully. A whole Bash command, prompt or file body is unique per call and
// would only reprint the list, so each tool names its own field and anything else
// gets no detail row.
//
// Bash needs more than the first word. 9,742 of 28,174 commands here begin `cd
// <path> &&`, so the naive first token is `cd` for 35% of them. Leading directory
// changes, exports and VAR=value assignments are stripped first, and the program is
// reduced to its basename so /usr/bin/git and git are one row.
const BASH_PREFIX = /^\(?\s*(?:(?:cd\s+\S+|export\s+\S+)\s*(?:&&|;)|[A-Za-z_][A-Za-z0-9_]*=\S+)\s*/;

function bashProgram(command) {
  if (typeof command !== 'string') return null;
  let rest = command.trim();
  // Bounded rather than while(true): a hand-written command can chain a few of
  // these, and an unbounded loop on a hostile string is not worth the risk.
  for (let i = 0; i < 4; i++) {
    const match = BASH_PREFIX.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length);
  }
  const program = /^\(?\s*([\w./-]+)/.exec(rest);
  return program ? program[1].split('/').pop() || null : null;
}

function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null; // a malformed url in a log is not a reason to fail the scan
  }
}

function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (name === 'Bash') return bashProgram(input.command);
  if (name === 'Agent') return typeof input.subagent_type === 'string' ? input.subagent_type : null;
  if (name === 'Skill') return typeof input.skill === 'string' ? input.skill : null;
  if (name === 'WebFetch') return hostOf(input.url);
  // Read, Write, Edit and NotebookEdit all name the file the same way.
  return typeof input.file_path === 'string' ? input.file_path : null;
}

// Enough of an error to recognise it. The median error on this machine is 325
// characters, and the panel shows one example per group, so a longer cap only adds
// payload.
const ERROR_TEXT_LIMIT = 300;

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ');
}

// A Write of a new file has no hunks (type 'create'), so its content lines count as
// added.
function createdLines(result) {
  const { content } = result;
  const added = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  return { added, removed: 0 };
}

// A hunk line starting '+' was added and one starting '-' was removed.
function patchLines(result) {
  let added = 0;
  let removed = 0;
  for (const hunk of result.structuredPatch) {
    if (!Array.isArray(hunk?.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

// Lines an Edit or Write changed, from the toolUseResult Claude Code stores on the
// same line as the tool_result. Anything other than a create or a non-empty
// structuredPatch, a Bash result's bashEditDiff included, counts nothing and
// returns null.
function editedLines(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.type === 'create' && typeof result.content === 'string') return createdLines(result);
  if (!Array.isArray(result.structuredPatch) || result.structuredPatch.length === 0) return null;
  return patchLines(result);
}

// A prompt the user typed, as opposed to the other user-type lines: tool results
// (array content), subagent task prompts (origin null), task notifications and
// coordinator relays (their own origin.kind), meta lines, and slash-command
// wrappers, which carry origin.kind 'human' but start '<command'. Checked against
// samples from this machine's transcripts.
function isTypedPrompt(parsed) {
  if (parsed.type !== 'user' || parsed.isMeta) return false;
  const content = parsed.message?.content;
  if (typeof content !== 'string' || content.trimStart().startsWith('<command')) return false;
  return parsed.origin?.kind === 'human' && (parsed.promptSource === 'typed' || parsed.promptSource === 'queued');
}

// A main-thread user line with prompt-shaped content and neither origin nor
// promptSource. A prompt line is tagged when it carries either one: typed prompts
// carry both, and `claude -p` lines carry promptSource 'sdk' and no origin.
// Compact summaries are not prompts. A file with untagged lines and no typed
// prompt suggests a Claude Code version that tags prompts another way, which
// isTypedPrompt would miss.
function isUntaggedPrompt(parsed) {
  if (parsed.type !== 'user' || parsed.isMeta || parsed.isSidechain === true) return false;
  if (Object.hasOwn(parsed, 'origin') || Object.hasOwn(parsed, 'promptSource') || parsed.isCompactSummary) return false;
  const content = parsed.message?.content;
  return typeof content === 'string' && !content.trimStart().startsWith('<command');
}

// Old transcripts stay on disk, so only lines from the last 7 days are evidence of the current Claude Code's tagging.
const UNTAGGED_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

// One warning per process is enough to send someone looking, and the server
// extracts every transcript on start. extractFile calls it only when recent
// untagged lines appear in a file with no typed prompt.
let warnedUntagged = false;
function warnUntagged(file) {
  if (warnedUntagged) return;
  warnedUntagged = true;
  console.warn(`[extract] ${file} has user prompts without origin or promptSource. Prompt counts and session reviews leave them out.`);
}

const PROMPT_PREVIEW_CHARS = 80;

// A typed prompt as a one-line title: pasted_content tags are removed, each run of
// whitespace becomes one space, and text longer than PROMPT_PREVIEW_CHARS is cut and
// ends in an ellipsis.
function promptPreview(text) {
  const unwrapped = text.replace(/^\s*<pasted_content[^>]*>/, '').replace(/<\/pasted_content>/g, '');
  const flat = unwrapped.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_PREVIEW_CHARS ? flat.slice(0, PROMPT_PREVIEW_CHARS - 1).trimEnd() + '…' : flat;
}

// Resolves true when the file was read to the end, and false when the read
// failed. A read fails on permission denied, or when the file was deleted after
// the directory walk found it: Claude Code's cleanupPeriodDays removes old
// transcripts. Lines read before a failure have already been passed to onLine. An
// error thrown by onLine is a bug in the caller, so it still rejects.
async function forEachLine(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let readError = null;
  stream.on('error', (err) => {
    readError = err;
    rl.close();
  });
  try {
    for await (const line of rl) {
      if (line.trim()) onLine(line);
    }
  } catch (err) {
    if (readError) return false;
    throw err;
  }
  return !readError;
}

// A tool_result with is_error becomes one error row. The text is cut to
// ERROR_TEXT_LIMIT here so a stored row never holds a whole tool output. `t` is null
// when the line has no usable timestamp, which the aggregate step reads as "inside
// every range", as the old scan did.
function collectErrors(content, timestamp, errors) {
  if (!Array.isArray(content)) return;
  const t = Date.parse(timestamp);
  for (const block of content) {
    if (block && block.type === 'tool_result' && block.is_error && block.tool_use_id) {
      errors.push({ toolUseId: block.tool_use_id, t: Number.isFinite(t) ? t : null, text: resultText(block.content).slice(0, ERROR_TEXT_LIMIT) });
    }
  }
}

// An Edit or Write result becomes one edit row, keyed on the tool_result's
// tool_use_id. A subagent's lines carry the parent's sessionId, so they count
// toward the parent.
function collectEdits(parsed, sessionId, edits) {
  const lines = editedLines(parsed.toolUseResult);
  if (!lines) return;
  const content = parsed.message?.content;
  const block = Array.isArray(content) ? content.find((b) => b && b.type === 'tool_result' && b.tool_use_id) : null;
  if (!block) return;
  const t = Date.parse(parsed.timestamp);
  edits.push({ toolUseId: block.tool_use_id, t: Number.isFinite(t) ? t : null, sessionId, added: lines.added, removed: lines.removed });
}

// One row per tool_use block. tool_use blocks frequently ride on a line after the
// first line of an API response, so every line of a group is read, not only the
// first. Real blocks carry a toolu_... id. One without falls back to the response
// key plus its position, so duplicate stream lines still collapse to one count in
// the aggregate step. Returns this line's tool names, for the call row's `tools`.
function collectToolUses(content, msgId, requestId, t, toolUses) {
  const names = [];
  if (!Array.isArray(content)) return names;
  content.forEach((block, i) => {
    if (!block || block.type !== 'tool_use') return;
    names.push(block.name || 'unknown');
    toolUses.push({ key: block.id || `${msgId}:${requestId}:${i}`, t, name: block.name || 'unknown', detail: toolDetail(block.name, block.input) });
  });
  return names;
}

// The rows extractFile returns, plus the running state it needs while reading one
// file. `file` is the sessionId of a line that carries none.
function newRowSet(file) {
  return {
    file,
    calls: [],
    toolUses: [],
    errors: [],
    edits: [],
    prompts: [],
    // No prototype, so a sessionId such as "constructor" or "__proto__" is an ordinary key.
    sessions: Object.create(null),
    minT: null,
    maxT: null,
    typed: 0,
    untagged: 0,
    // See addCall.
    pending: null,
  };
}

function noteTime(rows, t) {
  if (rows.minT === null || t < rows.minT) rows.minT = t;
  if (rows.maxT === null || t > rows.maxT) rows.maxT = t;
}

function sessionOf(rows, id) {
  return rows.sessions[id] || (rows.sessions[id] = { branches: [], newestBranch: null, title: null, firstPrompt: null, reportedCost: null });
}

function flushPending(rows) {
  if (rows.pending) rows.calls.push(rows.pending);
  rows.pending = null;
}

// Subagent lines share the parent's sessionId but can sit on another branch
// (a detached worktree writes 'HEAD'), so only the main thread sets the branch.
function noteBranch(rows, parsed, sessionId) {
  if (typeof parsed.gitBranch !== 'string' || !parsed.gitBranch || parsed.isSidechain === true) return;
  const s = sessionOf(rows, sessionId);
  if (!s.branches.includes(parsed.gitBranch)) s.branches.push(parsed.gitBranch);
  const t = Date.parse(parsed.timestamp);
  if (Number.isFinite(t) && (!s.newestBranch || t >= s.newestBranch.t)) s.newestBranch = { t, branch: parsed.gitBranch };
}

// The counter is cumulative over a session's life, so the highest value wins.
// Whether it is used is the aggregate step's decision: only an all-time scan.
function handleCostState(rows, parsed, sessionId) {
  if (parsed.type !== 'cost-state') return false;
  if (typeof parsed.totalCostUSD === 'number') {
    const s = sessionOf(rows, sessionId);
    if (parsed.totalCostUSD > (s.reportedCost || 0)) s.reportedCost = parsed.totalCostUSD;
  }
  return true;
}

// ai-title lines carry no timestamp and repeat through a transcript, so the last
// one in the file wins.
function handleAiTitle(rows, parsed, sessionId) {
  if (parsed.type !== 'ai-title') return false;
  if (typeof parsed.aiTitle === 'string' && parsed.aiTitle.trim()) sessionOf(rows, sessionId).title = parsed.aiTitle.trim();
  return true;
}

// Counts a recent untagged prompt for warnUntagged. Then records a typed prompt in
// `prompts` and as its session's firstPrompt.
function handleTypedPrompt(rows, parsed, sessionId) {
  if (isUntaggedPrompt(parsed)) {
    const at = Date.parse(parsed.timestamp);
    if (Number.isFinite(at) && at >= Date.now() - UNTAGGED_RECENT_MS) rows.untagged += 1;
  }
  if (!isTypedPrompt(parsed)) return false;
  rows.typed += 1;
  const s = sessionOf(rows, sessionId);
  if (s.firstPrompt === null) s.firstPrompt = promptPreview(parsed.message.content) || null;
  const t = Date.parse(parsed.timestamp);
  if (parsed.timestamp && !Number.isNaN(t)) {
    rows.prompts.push({ id: parsed.uuid || `${parsed.sessionId}:${parsed.timestamp}`, t, sessionId });
    noteTime(rows, t);
  }
  return true; // string content: no tool_result and no usage on this line
}

function callRow(parsed, { key, t, sessionId, model, usage, names }) {
  return {
    key,
    t,
    sessionId,
    sidechain: !!parsed.isSidechain,
    model: model || null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    usage,
    attributionSkill: parsed.attributionSkill || null,
    attributionAgent: parsed.attributionAgent || null,
    tools: names,
  };
}

// A response is written as one JSONL line per content block, and output_tokens
// grows across those lines as the response streams: a four-block response reads
// 5, 5, 5, 367. Only output_tokens moves - input, cache read and cache write
// carry their final value on every line. So the first line understates output and
// the sum over lines overstates everything else; neither is the response.
//
// A group's lines are always contiguous within a file (checked across 36,952
// groups: not one is interrupted by another response), so holding a single
// pending group and flushing it when the key changes gets the true figure without
// buffering the file. If that ever stopped holding, the aggregate step's dedupe on
// `key` would drop the stragglers.
function addCall(rows, parsed, call) {
  const { key, usage, names } = call;
  const { pending } = rows;
  // Another line of the response already being held: keep whichever carries the
  // most output, which is the last one written, and add this line's tools.
  if (key && pending && pending.key === key) {
    pending.tools.push(...names);
    if ((usage.output_tokens || 0) > (pending.usage.output_tokens || 0)) pending.usage = usage;
    return;
  }
  flushPending(rows);
  const row = callRow(parsed, call);
  // A line with no message id or requestId cannot be grouped, so it counts on its
  // own rather than being held.
  if (!key) rows.calls.push(row);
  else rows.pending = row;
}

function handleUsageLine(rows, parsed, sessionId) {
  // A tool_result rides on a user line, which carries no usage and would be
  // dropped by the gate below.
  collectErrors(parsed.message?.content, parsed.timestamp, rows.errors);
  collectEdits(parsed, sessionId, rows.edits);

  const usage = parsed.message?.usage;
  const ts = parsed.timestamp;
  if (!usage || usage.input_tokens == null || !ts) return;

  // A timestamp that is present but unparseable would make every derived index
  // NaN. Skip the line the same way a malformed JSON line is skipped.
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return;

  // A synthetic entry ('<synthetic>') is a local bookkeeping record, not an API
  // call. It also carries no requestId, so it would slip past the dedupe.
  const model = parsed.message?.model;
  if (model && model.startsWith('<')) return;

  const msgId = parsed.message?.id;
  const reqId = parsed.requestId;
  const names = collectToolUses(parsed.message?.content, msgId, reqId, t, rows.toolUses);
  noteTime(rows, t);

  const key = msgId && reqId ? `${msgId}:${reqId}` : null;
  addCall(rows, parsed, { key, t, sessionId, model, usage, names });
}

// Each handler after noteBranch returns true when it consumed the line. The
// handlers run in the order the checks ran before this split.
function readLine(rows, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // skip malformed lines rather than crash the whole scan
  }
  // null, a boolean, a number, a string or an array has none of the fields read
  // below, and reading sessionId from null throws.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const sessionId = parsed.sessionId || rows.file;
  noteBranch(rows, parsed, sessionId);
  if (handleCostState(rows, parsed, sessionId)) return;
  if (handleAiTitle(rows, parsed, sessionId)) return;
  if (handleTypedPrompt(rows, parsed, sessionId)) return;
  handleUsageLine(rows, parsed, sessionId);
}

/**
 * Reads one transcript from its first line to its last and returns its rows. No
 * cutoff is applied and nothing is deduped across files: lib/aggregate.js does both,
 * because a resumed session copies earlier lines into a new file. `ok` is false when
 * the read failed. The rows read before the failure are still returned.
 */
async function extractFile(file) {
  const rows = newRowSet(file);
  const ok = await forEachLine(file, (line) => readLine(rows, line));
  flushPending(rows); // a response never spans two files, so nothing can still be open
  if (rows.untagged > 0 && rows.typed === 0) warnUntagged(file);

  for (const e of rows.errors) if (e.t !== null) noteTime(rows, e.t);
  for (const e of rows.edits) if (e.t !== null) noteTime(rows, e.t);

  const { calls, toolUses, errors, edits, prompts, sessions, minT, maxT } = rows;
  return { ok, calls, toolUses, errors, edits, prompts, sessions, minT, maxT };
}

module.exports = { EXTRACT_VERSION, extractFile, forEachLine, isTypedPrompt, isUntaggedPrompt, promptPreview, toolDetail, resultText };
