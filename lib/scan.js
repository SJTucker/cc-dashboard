'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { costForUsage, cacheWriteTokens, priceFor, familyFor } = require('./pricing');
const { windowStart } = require('./window');

// A call's context is everything sent up: fresh input plus whatever was read
// from or written to the cache. Output is what came back, so it is excluded.
// 150k is where Claude Code's own usage view draws the line.
const LARGE_CONTEXT_TOKENS = 150000;

function getProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR.replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Recursively collect every *.jsonl file under a directory. Read-only: never writes. */
function findJsonlFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results; // directory doesn't exist or isn't readable - not fatal
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHourStr(d) {
  return `${localDateStr(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

function isRealModel(model) {
  return !!model && !model.startsWith('<');
}

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

// The first pattern that matches names the cause. Written from the 1,445 errors on
// this machine. A new kind of error lands in 'other' and still shows its message.
const ERROR_CAUSES = [
  ['blocked by the worktree check', /isolated in the worktree/],
  ['blocked by auto mode', /auto mode classifier/],
  ['rejected by you', /doesn't want to proceed|tool use was rejected/],
  ['command failed', /^Exit code \d+/],
  ['tool misused', /InputValidationError|File has not been read|String to replace not found|Found \d+ matches of the string|File does not exist|EISDIR/],
];

function errorCause(text) {
  for (const [cause, pattern] of ERROR_CAUSES) if (pattern.test(text)) return cause;
  return 'other';
}

// Paths and numbers differ between otherwise identical errors, so they are masked
// before grouping. A failed Bash command groups by exit code and program: the rest
// of its text is whatever the command printed, which is unique per call. `detail`
// is the program toolDetail() already extracted.
function errorMessage(name, detail, text) {
  const exit = /^Exit code (\d+)/.exec(text);
  if (name === 'Bash' && exit) return `exit ${exit[1]} · ${detail || 'unknown'}`;
  const first = text.split('\n')[0].replace(/<\/?tool_use_error>/g, '');
  return first.replace(/~?\/[^\s'"`),:]+/g, '<path>').replace(/\d+/g, 'N').trim().slice(0, 120) || '(no message)';
}

const ERROR_GROUP_LIMIT = 8;

function addError(entry, name, detail, error) {
  const cause = errorCause(error.text);
  entry.causeMap.set(cause, (entry.causeMap.get(cause) || 0) + 1);
  const message = errorMessage(name, detail, error.text);
  const key = `${cause}\n${message}`;
  const group = entry.groupMap.get(key);
  if (!group) {
    entry.groupMap.set(key, { cause, message, count: 1, example: error.text, t: error.t });
    return;
  }
  group.count += 1;
  if (error.t >= group.t) {
    group.example = error.text;
    group.t = error.t;
  }
}

// Folds the two collectors into one list per tool. Kept out of scanUsage, which
// was already over the complexity threshold before tools were added.
function summariseTools(toolById, toolErrors) {
  const toolMap = new Map();
  for (const [id, { name, detail }] of toolById) {
    if (!toolMap.has(name)) toolMap.set(name, { name, calls: 0, errors: 0, detailMap: new Map(), causeMap: new Map(), groupMap: new Map() });
    const entry = toolMap.get(name);
    const error = toolErrors.get(id);
    entry.calls += 1;
    if (error) {
      entry.errors += 1;
      addError(entry, name, detail, error);
    }
    if (!detail) continue;
    if (!entry.detailMap.has(detail)) entry.detailMap.set(detail, { name: detail, calls: 0, errors: 0 });
    const row = entry.detailMap.get(detail);
    row.calls += 1;
    if (error) row.errors += 1;
  }
  const byCalls = (a, b) => b.calls - a.calls;
  const byCount = (a, b) => b.count - a.count;
  // Only the rows the panel can draw are sent. A file_path breakdown runs to
  // thousands of entries and nothing past the top dozen is ever shown.
  return [...toolMap.values()].sort(byCalls).map(({ name, calls, errors, detailMap, causeMap, groupMap }) => ({
    name,
    calls,
    errors,
    details: [...detailMap.values()].sort(byCalls).slice(0, 15),
    errorCauses: [...causeMap].map(([cause, count]) => ({ cause, count })).sort(byCount),
    errorGroups: [...groupMap.values()].sort(byCount).slice(0, ERROR_GROUP_LIMIT),
  }));
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

function collectToolErrors(content, into, timestamp) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && block.type === 'tool_result' && block.is_error && block.tool_use_id) {
      into.set(block.tool_use_id, { text: resultText(block.content).slice(0, ERROR_TEXT_LIMIT), t: Date.parse(timestamp) || 0 });
    }
  }
}

// tool_use blocks frequently ride on a line AFTER the first line of an API
// response, so they must be counted before the dedupe return in the line
// handler drops every line but the first. Deduped on each block's own id
// (toolu_...), not on the message/request key those lines share. Takes no
// closure state - seenToolIds/toolById are the running totals summariseTools()
// reads later, mutated in place the same way collectToolErrors mutates `into`.
// Returns this line's tool names, for the Call record's `tools` field.
function collectToolUses(content, msgId, requestId, seenToolIds, toolById) {
  const lineTools = [];
  if (!Array.isArray(content)) return lineTools;
  content.forEach((block, i) => {
    if (!block || block.type !== 'tool_use') return;
    lineTools.push(block.name || 'unknown');
    // Real blocks carry a toolu_... id. One without falls back to the response
    // key plus its position, so duplicate stream lines still collapse to one
    // count instead of one per line.
    const key = block.id || `${msgId}:${requestId}:${i}`;
    if (seenToolIds.has(key)) return;
    seenToolIds.add(key);
    toolById.set(key, { name: block.name || 'unknown', detail: toolDetail(block.name, block.input) });
  });
  return lineTools;
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

async function forEachLine(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) onLine(line);
  }
}

/**
 * Scans every session file under ~/.claude/projects, aggregates token usage and estimated
 * cost by day and by model, restricted to the last `days` days (or all time if days is null).
 * Read-only throughout: only fs.readdirSync / fs.createReadStream are used.
 */
async function scanUsage({ days = 30, bucket = 'day' } = {}) {
  const projectsDir = getProjectsDir();
  const files = findJsonlFiles(projectsDir);

  // One `now` for both values, so a scan that runs across midnight cannot take
  // its window start from one day and today's date from the next.
  const now = Date.now();
  const midnight = windowStart('today', now);
  const cutoff = windowStart(days, now);
  const cutoffStr = cutoff ? new Date(cutoff).toISOString() : null;

  const dailyMap = new Map(); // date -> { input, output, cacheCreate, cacheRead, cost }
  const modelMap = new Map(); // model -> { cost, tokens }
  const seen = new Set(); // dedupe key: `${message.id}:${requestId}`

  // A fixed 7x24 grid, allocated full so the front end never fills gaps.
  // Index is weekday * 24 + hour, with weekday 0 = Sunday to match getDay().
  const activity = Array.from({ length: 7 * 24 }, (_, i) => ({
    weekday: Math.floor(i / 24),
    hour: i % 24,
    calls: 0,
    tokens: 0,
    cost: 0,
  }));

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreate = 0;
  let totalCacheRead = 0;
  let unpricedTokens = 0;
  const sessionIds = new Set();
  let apiCalls = 0;
  const seenToolIds = new Set(); // dedupe key: a tool_use block's own `id`
  // id -> { name, detail } for every tool_use, and the ids whose tool_result came
  // back with is_error, with that result's text. A result sits on a later line
  // than its call, and files are walked in directory order rather than
  // chronological order, so the two are joined after the scan instead of during it.
  const toolById = new Map();
  const toolErrors = new Map(); // tool_use id -> { text, t }

  // Claude Code tags each assistant line with the skill that was active and the
  // subagent type that made the call. Neither is present on most lines, so these
  // are shares of total cost, not a partition of it. `threads` is a partition.
  const skillCost = new Map();
  const agentCost = new Map();
  const threads = { main: 0, subagent: 0 };

  // Claude Code keeps its own running cost counter per session and writes it to
  // 'cost-state' lines. Those counters include API calls that never get a
  // transcript line - session titles, compaction summaries, background work - so
  // they run above anything this scan can price from requests. Kept separate
  // from totalCost, which has to stay equal to the sum of the daily, per-model
  // and skill/agent/thread breakdowns, all of which key off a real request.
  const reportedBySession = new Map();
  const context = { over: 0, under: 0 };

  // Compact per-call and per-prompt records for /api/changes, which needs to
  // regroup calls by session and by arbitrary time window. They stay on the server:
  // server.js strips `efficiency` before sending a summary.
  const calls = [];
  const prompts = [];
  const seenPromptIds = new Set(); // a resumed session copies earlier lines into its new file

  // Everything a response contributes to the totals. Split out of the line handler
  // so it runs once per response rather than once per line - see the pending group
  // below.
  function record(parsed, usage, model, when, file, tools = []) {
    // One session file can hold several sessions when a session is resumed,
    // so count the id rather than the file. Fall back to the path when an
    // older entry has no sessionId.
    sessionIds.add(parsed.sessionId || file);
    apiCalls += 1;

    // Priced at the record's own time, so a price change applies only from its
    // effective date and older usage keeps the price it had.
    const { cost, priced } = costForUsage(usage, model, when.getTime());

    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    // The same count costForUsage charges for.
    const cacheCreate = cacheWriteTokens(usage).total;
    const cacheRead = usage.cache_read_input_tokens || 0;

    totalCost += cost;
    threads[parsed.isSidechain ? 'subagent' : 'main'] += cost;
    const contextTokens = input + cacheRead + cacheCreate;
    context[contextTokens > LARGE_CONTEXT_TOKENS ? 'over' : 'under'] += cost;
    if (parsed.attributionSkill) {
      skillCost.set(parsed.attributionSkill, (skillCost.get(parsed.attributionSkill) || 0) + cost);
    }
    if (parsed.attributionAgent) {
      agentCost.set(parsed.attributionAgent, (agentCost.get(parsed.attributionAgent) || 0) + cost);
    }
    totalInput += input;
    totalOutput += output;
    totalCacheCreate += cacheCreate;
    totalCacheRead += cacheRead;
    if (!priced) unpricedTokens += input + output + cacheCreate + cacheRead;

    const day = bucket === 'hour' ? localHourStr(when) : localDateStr(when);

    // Same local-time Date as the bucket key, so this inherits the known
    // daylight-saving fall-back behaviour rather than adding a second one.
    const cell = activity[when.getDay() * 24 + when.getHours()];
    cell.calls += 1;
    cell.tokens += input + output + cacheCreate + cacheRead;
    cell.cost += cost;

    if (!dailyMap.has(day)) {
      dailyMap.set(day, { date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, byModel: {}, costByModel: {} });
    }
    const slot = dailyMap.get(day);
    slot.input += input;
    slot.output += output;
    slot.cacheCreate += cacheCreate;
    slot.cacheRead += cacheRead;
    slot.cost += cost;

    if (isRealModel(model)) {
      const family = familyFor(model);
      slot.byModel[family] = (slot.byModel[family] || 0) + input + output + cacheCreate + cacheRead;
      slot.costByModel[family] = (slot.costByModel[family] || 0) + cost;

      // priceFor depends only on the model name, so the first call's priced flag
      // holds for every call of the same model.
      if (!modelMap.has(model)) modelMap.set(model, { model, family, cost: 0, tokens: 0, priced });
      const m = modelMap.get(model);
      m.cost += cost;
      m.tokens += input + output + cacheCreate + cacheRead;
    }

    calls.push({
      t: when.getTime(),
      sessionId: parsed.sessionId || file,
      main: !parsed.isSidechain,
      model: isRealModel(model) ? model : null,
      context: input + cacheCreate + cacheRead,
      cacheRead,
      output,
      cost,
      tools,
    });
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
  // buffering the file. If that ever stopped holding, `seen` would drop the
  // stragglers - which is what this code did to every line but the first anyway.
  let pending = null;

  function flushPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (seen.has(p.key)) return; // the same response, also copied into another session file
    seen.add(p.key);
    record(p.parsed, p.usage, p.model, p.when, p.file, p.tools);
  }

  // A closure rather than a module-level helper because it needs scanUsage's
  // own cutoffStr, seenPromptIds and prompts. Called from the line handler,
  // which still returns right after: a typed prompt's content is a string, so
  // it carries no tool_result and no usage.
  function recordPrompt(parsed, file) {
    if (!parsed.timestamp || (cutoffStr && parsed.timestamp < cutoffStr)) return;
    const t = Date.parse(parsed.timestamp);
    const id = parsed.uuid || `${parsed.sessionId}:${parsed.timestamp}`;
    if (Number.isNaN(t) || seenPromptIds.has(id)) return;
    seenPromptIds.add(id);
    prompts.push({ t, sessionId: parsed.sessionId || file });
  }

  for (const file of files) {
    // A session file is appended to as entries are written, so its mtime is the
    // timestamp of its newest entry. One last written before the cutoff cannot
    // hold an in-range entry, so skip it without reading. This is what makes the
    // 'today' range cheap enough to poll: 20 files instead of 729 on a typical
    // log directory. statSync throwing means the file vanished since the
    // directory walk, which is also nothing to read.
    if (cutoff != null) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;
    }
    await forEachLine(file, (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // skip malformed lines rather than crash the whole scan
      }

      // The counter is cumulative over a session's life, so the highest value
      // wins rather than the sum. Only collected on an all-time scan: a windowed
      // scan cannot split one session's lifetime total across days, and charging
      // the whole of it to the window would overstate every short range.
      if (parsed.type === 'cost-state') {
        if (cutoff == null && typeof parsed.totalCostUSD === 'number') {
          const id = parsed.sessionId || file;
          if (parsed.totalCostUSD > (reportedBySession.get(id) || 0)) {
            reportedBySession.set(id, parsed.totalCostUSD);
          }
        }
        return;
      }

      if (isTypedPrompt(parsed)) {
        recordPrompt(parsed, file);
        return; // string content: no tool_result and no usage on this line
      }

      // A tool_result rides on a user line, which carries no usage and would be
      // dropped by the gate below.
      if (!cutoffStr || !parsed.timestamp || parsed.timestamp >= cutoffStr) {
        collectToolErrors(parsed.message?.content, toolErrors, parsed.timestamp);
      }

      const usage = parsed.message?.usage;
      const ts = parsed.timestamp;
      if (!usage || usage.input_tokens == null || !ts) return;
      if (cutoffStr && ts < cutoffStr) return;

      // A timestamp that is present but unparseable would make every derived
      // index NaN, and activity[NaN] is undefined. Skip the line the same way a
      // malformed JSON line is skipped, rather than failing the whole scan.
      const when = new Date(ts);
      if (Number.isNaN(when.getTime())) return;

      // A synthetic entry ('<synthetic>') is a local bookkeeping record, not an
      // API call. Counting its tokens in the totals while excluding it from the
      // per-model breakdown put the two out of balance; it also carries no
      // requestId, so it slipped past the dedupe below.
      const model = parsed.message?.model;
      if (model && model.startsWith('<')) return;

      // See collectToolUses: this has to run before the dedupe return below
      // drops every line but the first.
      const content = parsed.message?.content;
      const lineTools = collectToolUses(content, parsed.message?.id, parsed.requestId, seenToolIds, toolById);

      const msgId = parsed.message?.id;
      const reqId = parsed.requestId;
      const key = msgId && reqId ? `${msgId}:${reqId}` : null;

      // Another line of the response already being held: keep whichever carries the
      // most output, which is the last one written, and add this line's tools.
      if (key && pending && pending.key === key) {
        pending.tools.push(...lineTools);
        if ((usage.output_tokens || 0) > (pending.usage.output_tokens || 0)) pending.usage = usage;
        return;
      }
      flushPending();
      // A line with no message id or requestId cannot be grouped, so it counts on
      // its own rather than being held.
      if (!key) {
        record(parsed, usage, model, when, file, lineTools);
        return;
      }
      pending = { key, parsed, usage, model, when, file, tools: lineTools };
      return;
    });
    flushPending(); // a response never spans two files, so nothing can still be open
  }

  // A full-day axis keeps the live Today chart's bars stationary as the day fills
  // in, instead of rescaling every bar on each new hour. Hours with no usage
  // render as real gaps. `midnight` is the same value the cutoff used, so a scan
  // that crosses midnight cannot key its entries to one day and its filler slots
  // to the next.
  //
  // This is 24 slots on an ordinary day and 23 on the spring-forward day, where
  // setHours(2) rolls to 3am because 2am does not exist locally. That is the
  // day's real shape, so the Map's key collision is the correct outcome rather
  // than something to pad back to 24.
  if (bucket === 'hour') {
    for (let h = 0; h < 24; h++) {
      const slotDate = new Date(midnight);
      slotDate.setHours(h);
      const key = localHourStr(slotDate);
      if (!dailyMap.has(key)) {
        dailyMap.set(key, { date: key, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, byModel: {}, costByModel: {} });
      }
    }
  }

  // Every key collectToolUses adds to toolById is one it hadn't seen before -
  // seenToolIds guards against a second entry for the same tool_use - so the
  // map's size is exactly the same count a manual toolCalls++ would have made.
  const toolCalls = toolById.size;
  const tools = summariseTools(toolById, toolErrors);

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const models = [...modelMap.values()].sort((a, b) => b.cost - a.cost);

  const byCost = (map) =>
    [...map].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost);

  const totalTokens = totalInput + totalOutput + totalCacheCreate + totalCacheRead;
  const cacheEligible = totalInput + totalCacheCreate + totalCacheRead; // tokens that could have been cache reads
  const cacheEfficiency = cacheEligible > 0 ? totalCacheRead / cacheEligible : 0;

  return {
    meta: {
      projectsDir,
      dirExists: fs.existsSync(projectsDir),
      scannedFiles: files.length,
    },
    tools,
    summary: {
      totalCost,
      totalTokens,
      totalInput,
      totalOutput,
      totalCacheCreate,
      totalCacheRead,
      cacheEfficiency,
      unpricedTokens,
      sessions: sessionIds.size,
      apiCalls,
      toolCalls,
      toolErrors: toolErrors.size,
      // null on a windowed scan, where the figure would not be comparable.
      reportedCost: cutoff == null ? [...reportedBySession.values()].reduce((a, b) => a + b, 0) : null,
      reportedSessions: reportedBySession.size,
      // The "of M" in "over N of M sessions". A session can write a cost-state
      // line before any response logs usage, so it is in reportedBySession but
      // not in sessionIds. Both key on sessionId, so the union counts it once.
      reportedSessionsOf: cutoff == null ? new Set([...sessionIds, ...reportedBySession.keys()]).size : null,
    },
    daily,
    activity,
    models,
    skills: byCost(skillCost),
    subagents: byCost(agentCost),
    threads,
    context,
    contextThreshold: LARGE_CONTEXT_TOKENS,
    efficiency: { calls, prompts },
  };
}

module.exports = { scanUsage, getProjectsDir, localDateStr };
