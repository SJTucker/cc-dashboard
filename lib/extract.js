'use strict';

const path = require('path');
const { findRepo, configDirOf } = require('./repo');
const { cacheWriteTokens } = require('./pricing');
const { TTL_5M_MS, nextTtl } = require('./cache');
const { readAgentSteps } = require('./agent-steps');
const { forEachLine, isTypedPrompt, isUntaggedPrompt, promptPreview, toolDetail, resultText, bashGroup } = require('./transcript-lines');

// Bump when extractFile starts producing different rows. A file still on disk with
// an older version is re-extracted. Rows whose transcript is gone are upgraded by a
// migration in lib/store.js instead: MIGRATIONS has 1 to 2, 2 to 3, 8 to 9 and 9 to 10, and identity
// steps for 3 to 4, 4 to 5, 5 to 6, 6 to 7, 7 to 8 and 10 to 11. loadAll migrates every stored row set in memory.
//
// 2: command rows (slash commands typed). Migration 1 to 2 adds the empty list.
// 3: `model` on tool use rows. Migration 2 to 3 adds `model`, null where the call
// row it belongs to is not known.
// 4: missReason on the call rows where Claude Code gave a reason, and rebuild on the
// calls that rebuilt the prompt cache (markRebuilds).
// 5: agentId on subagent call rows, noFinal on responses none of whose lines had a
// stop_reason, and step files (lib/agent-steps.js) read through extractFile.
// 6: tool_use blocks without an id are keyed by apiBlockIndex, else a per-response
// counter, where version 5 gave every one of them the key msg:req:0.
// 7: `recap` on each session, from Claude Code's away_summary lines. Rows of version 6
// have no recap, which reads as none.
// 8: a forked-skill line (origin human, no promptSource, content starting '/') is a
// typed prompt. Rows of version 7 have no prompt row or title for a session that
// holds only such a line.
// 9: `results` (the text length of every tool_result), `turns` (main-thread
// turn_duration lines) and `group` on Bash tool uses (bashGroup). Migration 8 to 9
// adds empty lists, so a deleted transcript's rows have no sizes and no turns.
// 10: `repo` on edit rows, the main checkout of the edited file's repo (lib/repo.js).
// Migration 9 to 10 resolves it from the transcript's folder name.
// 11: no edit row for scratchpad, memory or global CLAUDE.md files. Migration 10 to 11
// changes nothing: a deleted transcript's rows have no file path to test.
const EXTRACT_VERSION = 11;

// Enough of an error to recognise it. The median error on this machine is 325
// characters, and the panel shows one example per group, so a longer cap only adds
// payload.
const ERROR_TEXT_LIMIT = 300;

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

// The repo an Edit or Write changed: from the edited file's folder, so an edit in
// one repo from a session started in another counts toward the edited one. The
// line's cwd is used only when the result has no filePath.
function editRepo(parsed) {
  const file = parsed.toolUseResult?.filePath;
  if (typeof file === 'string' && file) return findRepo(path.dirname(file));
  return typeof parsed.cwd === 'string' && parsed.cwd ? findRepo(parsed.cwd) : null;
}

// Edits to these files are working notes and settings, not code in a repo, so they
// count in no line total: a session scratchpad (<tmp>/claude-<uid>/<folder>/<session>/scratchpad/),
// a memory file (<cfg>/projects/<folder>/memory/) and the global <cfg>/CLAUDE.md.
// `configDir` is null for a transcript outside any projects folder, which leaves
// only the scratchpad rule.
function excludedEdit(filePath, configDir) {
  const norm = filePath.replace(/\\/g, '/');
  if (/(^|\/)claude-\d+\/[^/]+\/[^/]+\/scratchpad\//.test(norm)) return true;
  if (!configDir) return false;
  const cfg = configDir.replace(/\\/g, '/');
  if (norm === `${cfg}/CLAUDE.md`) return true;
  const projects = `${cfg}/projects/`;
  return norm.startsWith(projects) && /^[^/]+\/memory\//.test(norm.slice(projects.length));
}

// An Edit or Write result becomes one edit row, keyed on the tool_result's
// tool_use_id. A subagent's lines carry the parent's sessionId, so they count
// toward the parent.
function collectEdits(parsed, sessionId, edits, transcriptPath) {
  const lines = editedLines(parsed.toolUseResult);
  if (!lines) return;
  const filePath = parsed.toolUseResult?.filePath;
  if (typeof filePath === 'string' && excludedEdit(filePath, configDirOf(transcriptPath))) return;
  const content = parsed.message?.content;
  const block = Array.isArray(content) ? content.find((b) => b && b.type === 'tool_result' && b.tool_use_id) : null;
  if (!block) return;
  const t = Date.parse(parsed.timestamp);
  edits.push({ toolUseId: block.tool_use_id, t: Number.isFinite(t) ? t : null, sessionId, added: lines.added, removed: lines.removed, repo: editRepo(parsed) });
}

// Every tool_result block becomes one result row with the length of the text the
// model saw (resultText). The toolUseResult field on the same line is Claude Code's
// UI payload and runs about 2.3 times larger, so it is not measured. A subagent line
// names its agent, which lib/fillers.js uses to tell one thread's reads from
// another's.
function collectResults(parsed, sessionId, results) {
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;
  const t = Date.parse(parsed.timestamp);
  for (const block of content) {
    if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;
    const row = { toolUseId: block.tool_use_id, t: Number.isFinite(t) ? t : null, sessionId, chars: resultText(block.content).length };
    if (typeof parsed.agentId === 'string' && parsed.agentId) row.agentId = parsed.agentId;
    results.push(row);
  }
}

// The index of an id-less block among its response's id-less blocks, for a line
// without apiBlockIndex. A block with the same name and input as an earlier one
// of the response is a duplicate stream line and gets that block's index.
function counterIndex(rows, response, block) {
  const seen = rows.idlessUses[response] || (rows.idlessUses[response] = new Map());
  const signature = JSON.stringify([block.name, block.input]);
  if (!seen.has(signature)) seen.set(signature, seen.size);
  return seen.get(signature);
}

// One row per tool_use block. tool_use blocks frequently ride on a line after the
// first line of an API response, so every line of a group is read, not only the
// first. Real blocks carry a toolu_... id. One without falls back to the response
// key plus the block's index in the response: `apiBlockIndex`, which Claude Code
// writes on each line, or else a count of the response's id-less blocks so far.
// (A block's index inside its own line is 0 on every line, so it cannot tell two
// blocks of one response apart.) Returns this line's tool names, for the call row's
// `tools`.
function collectToolUses(content, msgId, requestId, t, model, rows, apiBlockIndex) {
  const names = [];
  if (!Array.isArray(content)) return names;
  content.forEach((block, i) => {
    if (!block || block.type !== 'tool_use') return;
    names.push(block.name || 'unknown');
    let key = block.id;
    if (!key) {
      const response = `${msgId}:${requestId}`;
      key = `${response}:${Number.isInteger(apiBlockIndex) ? apiBlockIndex + i : counterIndex(rows, response, block)}`;
    }
    const row = { key, t, name: block.name || 'unknown', detail: toolDetail(block.name, block.input), model: model || null };
    const group = block.name === 'Bash' ? bashGroup(block.input?.command) : null;
    if (group) row.group = group;
    rows.toolUses.push(row);
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
    results: [],
    turns: [],
    prompts: [],
    commands: [],
    // Times (ms) of the main thread's compact_boundary lines. Read by markRebuilds
    // only, and not part of what extractFile returns.
    compactions: [],
    // Per `msgId:requestId`, a Map from an id-less tool_use block's name and input
    // to its index in the response. See counterIndex. Not part of what extractFile
    // returns.
    idlessUses: Object.create(null),
    // No prototype, so a sessionId such as "constructor" or "__proto__" is an ordinary key.
    sessions: Object.create(null),
    minT: null,
    maxT: null,
    typed: 0,
    untagged: 0,
    // See addCall.
    pending: null,
    // True once any line of the pending response had a stop_reason. See flushPending.
    pendingFinal: false,
  };
}

function noteTime(rows, t) {
  if (rows.minT === null || t < rows.minT) rows.minT = t;
  if (rows.maxT === null || t > rows.maxT) rows.maxT = t;
}

function sessionOf(rows, id) {
  return rows.sessions[id] || (rows.sessions[id] = { branches: [], newestBranch: null, title: null, recap: null, firstPrompt: null, reportedCost: null });
}

// A response none of whose lines carried a stop_reason never got its final usage
// line, so its output_tokens is the stream-start figure. lib/aggregate.js replaces it
// with the mod's record of the step when there is one (lib/agent-steps.js). A
// response still streaming when the file is read is marked too, until the next read.
function flushPending(rows) {
  if (rows.pending) {
    if (!rows.pendingFinal) rows.pending.noFinal = true;
    rows.calls.push(rows.pending);
  }
  rows.pending = null;
  rows.pendingFinal = false;
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

// Claude Code writes an away_summary line when the user returns to an idle session.
// Its content ends with a hint about turning recaps off, which is not part of the
// recap. The last one in the file wins, like ai-title.
const RECAP_HINT = /\s*\(disable recaps in \/config\)\s*$/;
function handleAwaySummary(rows, parsed, sessionId) {
  if (parsed.type !== 'system' || parsed.subtype !== 'away_summary') return false;
  if (typeof parsed.content === 'string') {
    const recap = parsed.content.replace(RECAP_HINT, '').trim();
    if (recap) sessionOf(rows, sessionId).recap = recap;
  }
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

// The command in a slash command line's <command-name>, without its slash.
const COMMAND_NAME = /<command-name>\/?([^<\s]+)\s*<\/command-name>/;

// A slash command line becomes one command row. Claude Code writes a skill or custom
// command as a user line that starts <command-message>, and a built-in such as /clear
// as one that starts <command-name>. Both name the command in <command-name>.
// Built-ins are kept: lib/aggregate.js adds a command to a skill's invocations only
// when the names match, and no skill is named clear. A prompt that only quotes the
// tag further in does not start with it, so it stays a prompt. The row is keyed
// like a prompt row, so a resumed session's copy counts once.
function handleCommand(rows, parsed, sessionId) {
  if (parsed.type !== 'user' || parsed.isMeta) return false;
  const content = parsed.message?.content;
  if (typeof content !== 'string' || !content.trimStart().startsWith('<command')) return false;
  const match = COMMAND_NAME.exec(content);
  const t = Date.parse(parsed.timestamp);
  if (match && Number.isFinite(t)) {
    rows.commands.push({ id: parsed.uuid || `${sessionId}:${parsed.timestamp}`, t, name: match[1] });
    noteTime(rows, t);
  }
  return true; // string content: not a prompt, and no tool_result and no usage on this line
}

// Claude Code's own reason for a prompt-cache miss. From 2.1.248 some assistant lines
// carry message.diagnostics.cache_miss_reason = { type, cache_missed_input_tokens }.
function missReasonOf(parsed) {
  const type = parsed.message?.diagnostics?.cache_miss_reason?.type;
  return typeof type === 'string' ? type : null;
}

function callRow(parsed, { key, t, sessionId, model, usage, names }) {
  const row = {
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
  const missReason = missReasonOf(parsed);
  if (missReason) row.missReason = missReason;
  // A subagent line names its agent, the same id as its agent-<id>.jsonl file.
  if (typeof parsed.agentId === 'string' && parsed.agentId) row.agentId = parsed.agentId;
  return row;
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
  const final = parsed.message?.stop_reason != null;
  // Another line of the response already being held: keep whichever carries the
  // most output, which is the last one written, and add this line's tools.
  if (key && pending && pending.key === key) {
    pending.tools.push(...names);
    if ((usage.output_tokens || 0) > (pending.usage.output_tokens || 0)) pending.usage = usage;
    if (!pending.missReason) pending.missReason = missReasonOf(parsed);
    if (final) rows.pendingFinal = true;
    return;
  }
  flushPending(rows);
  const row = callRow(parsed, call);
  // A line with no message id or requestId cannot be grouped, so it counts on its
  // own rather than being held.
  if (!key) {
    rows.calls.push(row);
  } else {
    rows.pending = row;
    rows.pendingFinal = final;
  }
}

// Claude Code writes a compact_boundary line at each compaction. The next main-thread
// call starts a new cache conversation, see markRebuilds.
function handleCompaction(rows, parsed) {
  if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') return false;
  const t = Date.parse(parsed.timestamp);
  if (parsed.isSidechain !== true && Number.isFinite(t)) rows.compactions.push(t);
  return true;
}

// Claude Code writes a turn_duration line when a main-loop turn ends. durationMs runs
// from the prompt to the end of the turn, so it includes tool time and time spent
// waiting on the user. Subagent files have none, and a background subagent that
// keeps running after the turn ends is not in it.
function handleTurnDuration(rows, parsed, sessionId) {
  if (parsed.type !== 'system' || parsed.subtype !== 'turn_duration') return false;
  const t = Date.parse(parsed.timestamp);
  const ms = parsed.durationMs;
  if (parsed.isSidechain !== true && Number.isFinite(t) && Number.isFinite(ms) && ms >= 0) {
    rows.turns.push({ id: parsed.uuid || `${sessionId}:${parsed.timestamp}`, t, sessionId, durationMs: ms });
    noteTime(rows, t);
  }
  return true;
}

function handleUsageLine(rows, parsed, sessionId) {
  // A tool_result rides on a user line, which carries no usage and would be
  // dropped by the gate below.
  collectErrors(parsed.message?.content, parsed.timestamp, rows.errors);
  collectEdits(parsed, sessionId, rows.edits, rows.file);
  collectResults(parsed, sessionId, rows.results);

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
  const names = collectToolUses(parsed.message?.content, msgId, reqId, t, model, rows, parsed.apiBlockIndex);
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
  if (handleAwaySummary(rows, parsed, sessionId)) return;
  if (handleCommand(rows, parsed, sessionId)) return;
  if (handleCompaction(rows, parsed)) return;
  if (handleTurnDuration(rows, parsed, sessionId)) return;
  if (handleTypedPrompt(rows, parsed, sessionId)) return;
  handleUsageLine(rows, parsed, sessionId);
}

// A call that wrote at least this many tokens to the prompt cache can count as a
// rebuild. Smaller misses cost under about $0.05 and would crowd the timeline.
const REBUILD_MIN_TOKENS = 20_000;
// Without Claude Code's reason, a call is a rebuild when its cache write is more
// than this share of its context.
const REBUILD_SHARE = 0.8;

// cache_miss_reason types, measured on 2026-10-10. Any other type is 'other', and
// the raw type stays in rebuild.reason for the tooltip.
const MISS_CAUSES = {
  previous_message_not_found: 'expired',
  messages_changed: 'messages',
  tools_changed: 'tools',
  system_changed: 'system',
  model_changed: 'model',
  unavailable: 'unavailable',
};

function rebuildCause(call, prev, gapMs, ttl) {
  if (call.missReason) return MISS_CAUSES[call.missReason] || 'other';
  if (call.model !== prev.model) return 'model';
  return gapMs > ttl ? 'expired' : 'unknown';
}

// The rebuild record for one call, or null when the call read its cache. `ttl` is
// the lifetime of the conversation's latest cache write before this call.
function rebuildOf(call, prev, ttl) {
  const write = cacheWriteTokens(call.usage).total;
  if (write < REBUILD_MIN_TOKENS) return null;
  const context = (call.usage.input_tokens || 0) + write + (call.usage.cache_read_input_tokens || 0);
  if (!call.missReason && write <= REBUILD_SHARE * context) return null;
  const gapMs = call.t - prev.t;
  return { cause: rebuildCause(call, prev, gapMs, ttl), reason: call.missReason || null, tokens: write, gapMs };
}

// A call starts a conversation when it is the first, or when a compaction happened
// between the call before it and this call.
function startsConversation(call, prev, compactions) {
  return !prev || compactions.some((c) => prev.t < c && c <= call.t);
}

function markConversation(calls, compactions) {
  const ordered = [...calls].sort((a, b) => a.t - b.t);
  let ttl = TTL_5M_MS;
  ordered.forEach((call, i) => {
    const prev = ordered[i - 1];
    if (startsConversation(call, prev, compactions)) {
      ttl = TTL_5M_MS;
    } else {
      const rebuild = rebuildOf(call, prev, ttl);
      if (rebuild) call.rebuild = rebuild;
    }
    ttl = nextTtl(call.usage, ttl);
  });
}

// Sets `rebuild` on each call that wrote most of its context to the prompt cache
// again. Calls are compared inside one cache conversation: the main thread, or the
// sidechain lines, which in a subagent file are that subagent's own. A
// conversation's first call has no cache to lose, so it is never a rebuild. The
// first main-thread call after a compaction (`compactions` holds the times of the
// compact_boundary lines) starts a new conversation the same way, with the TTL back
// at 5 minutes, because compaction rewrites the context. Sidechain calls ignore
// compactions. The whole file is read first, so a session that began before midnight still has the
// call before its first call today. The order of `calls` is left alone.
function markRebuilds(calls, compactions = []) {
  markConversation(calls.filter((c) => !c.sidechain), compactions);
  markConversation(calls.filter((c) => c.sidechain), []);
  return calls;
}

/**
 * Reads one transcript from its first line to its last and returns its rows. No
 * cutoff is applied and nothing is deduped across files: lib/aggregate.js does both,
 * because a resumed session copies earlier lines into a new file. `ok` is false when
 * the read failed. The rows read before the failure are still returned.
 * A path ending in `.json` is a step file (lib/agent-steps.js).
 */
async function extractFile(file) {
  // The mod's step files go through here too, so the worker pool reads them.
  if (file.endsWith('.json')) return readAgentSteps(file);
  const rows = newRowSet(file);
  const ok = await forEachLine(file, (line) => readLine(rows, line));
  flushPending(rows); // a response never spans two files, so nothing can still be open
  markRebuilds(rows.calls, rows.compactions);
  if (rows.untagged > 0 && rows.typed === 0) warnUntagged(file);

  for (const e of rows.errors) if (e.t !== null) noteTime(rows, e.t);
  for (const e of rows.edits) if (e.t !== null) noteTime(rows, e.t);
  for (const r of rows.results) if (r.t !== null) noteTime(rows, r.t);

  const { calls, toolUses, errors, edits, results, turns, prompts, commands, sessions, minT, maxT } = rows;
  return { ok, calls, toolUses, errors, edits, results, turns, prompts, commands, sessions, minT, maxT };
}

module.exports = { EXTRACT_VERSION, markRebuilds, REBUILD_MIN_TOKENS, extractFile };
