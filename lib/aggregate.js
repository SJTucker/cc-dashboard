'use strict';

const fs = require('fs');
const { costForUsage, cacheWriteTokens, outputRate, familyFor, shortModelLabel } = require('./pricing');
const { windowStart, localDateStr, localHourStr, hourSlots } = require('./dates');
const { stepKey } = require('./agent-steps');

// A call's context is everything sent up: fresh input plus whatever was read
// from or written to the cache. Output is what came back, so it is excluded.
// 150k is where Claude Code's own usage view draws the line.
const LARGE_CONTEXT_TOKENS = 150000;

// A daily or hourly bucket with nothing in it yet.
/** familyRate is stored on a modelMap entry only when true, so other entries keep their shape. */
function familyRateFlag(familyRate) {
  return familyRate ? { familyRate: true } : {};
}

function emptyBucket(key) {
  return { date: key, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, thinking: 0, thinkingOutput: 0, thinkingCost: 0, byModel: {}, costByModel: {} };
}

function isRealModel(model) {
  return !!model && !model.startsWith('<');
}

// The first pattern that matches names the cause. Written from the 1,445 errors on
// this machine, and extended on 2026-10-10 from the messages that had landed in
// 'other'. A new kind of error lands in 'other' and still shows its message.
// public/panels/tools.mjs names some of these causes, so a rename must change both.
const ERROR_CAUSES = [
  ['blocked by the worktree check', /isolated in the worktree/],
  ['blocked by auto mode', /auto mode classifier/],
  ['blocked by a hook', /^PreToolUse:\S+ hook error/],
  ['rejected by you', /doesn't want to proceed|tool use was rejected|doesn't want to take this action/],
  ['command failed', /^Exit code \d+/],
  ['tool misused', /InputValidationError|File has not been read|String to replace not found|Found \d+ matches of the string|File does not exist|EISDIR|No such tool available|File has been modified since read|exceeds maximum allowed tokens|No changes to make|Missing required parameter/],
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

function addError(entry, name, detail, error, cause) {
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

const UNKNOWN_MODEL = 'Unknown model';
const byCalls = (a, b) => b.calls - a.calls;
const byCount = (a, b) => b.count - a.count;
const causeList = (causeMap) => [...causeMap].map(([cause, count]) => ({ cause, count })).sort(byCount);

function newToolEntry(name) {
  return { name, calls: 0, errors: 0, detailMap: new Map(), causeMap: new Map(), groupMap: new Map(), modelMap: new Map() };
}

// One row per model label, so two ids that print the same label share a row.
function addModelUse(entry, model, cause) {
  const label = model ? shortModelLabel(model) : UNKNOWN_MODEL;
  if (!entry.modelMap.has(label)) {
    entry.modelMap.set(label, { label, family: model ? familyFor(model) : 'other', calls: 0, errors: 0, causeMap: new Map() });
  }
  const row = entry.modelMap.get(label);
  row.calls += 1;
  if (!cause) return;
  row.errors += 1;
  row.causeMap.set(cause, (row.causeMap.get(cause) || 0) + 1);
}

function addUse(entry, use, error, cause) {
  entry.calls += 1;
  if (error) {
    entry.errors += 1;
    addError(entry, use.name, use.detail, error, cause);
  }
  addModelUse(entry, use.model, cause);
}

function addDetail(entry, detail, error) {
  if (!entry.detailMap.has(detail)) entry.detailMap.set(detail, { name: detail, calls: 0, errors: 0 });
  const row = entry.detailMap.get(detail);
  row.calls += 1;
  if (error) row.errors += 1;
}

// Only the rows the panel can draw are sent. A file_path breakdown runs to
// thousands of entries and nothing past the top dozen is ever shown.
function finishEntry({ name, calls, errors, detailMap, causeMap, groupMap, modelMap }) {
  return {
    name,
    calls,
    errors,
    details: [...detailMap.values()].sort(byCalls).slice(0, 15),
    errorCauses: causeList(causeMap),
    errorGroups: [...groupMap.values()].sort(byCount).slice(0, ERROR_GROUP_LIMIT),
    byModel: [...modelMap.values()].sort(byCalls).map(({ causeMap: modelCauses, ...row }) => ({ ...row, errorCauses: causeList(modelCauses) })),
  };
}

// Folds the two collectors into one entry per tool, plus one entry for every tool
// together. Kept out of aggregate, which was already over the complexity threshold
// before tools were added. The total entry has no details, because its breakdown
// is the tool list itself.
function summariseTools(toolById, toolErrors) {
  const toolMap = new Map();
  const total = newToolEntry('All tools');
  for (const [id, use] of toolById) {
    if (!toolMap.has(use.name)) toolMap.set(use.name, newToolEntry(use.name));
    const entry = toolMap.get(use.name);
    const error = toolErrors.get(id);
    const cause = error ? errorCause(error.text) : null;
    addUse(entry, use, error, cause);
    addUse(total, use, error, cause);
    if (use.detail) addDetail(entry, use.detail, error);
  }
  return { tools: [...toolMap.values()].sort(byCalls).map(finishEntry), toolTotals: finishEntry(total) };
}

// An Agent call with no subagent_type starts a general-purpose subagent. All 3 such
// calls in this machine's transcripts did, on 2026-10-10.
const DEFAULT_SUBAGENT = 'general-purpose';

// Skill and Agent tool calls per skill and per subagent type, for the counts on the
// Skills and Subagents rows of Where usage goes. toolById is already deduped on the
// tool_use id, so a call copied into a resumed session's file counts once. A skill
// started with a slash command makes no Skill call, so its count starts from
// commandCounts.
function invocationCounts(toolById, commandCounts) {
  const skills = new Map(commandCounts);
  const agents = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const { name, detail } of toolById.values()) {
    if (name === 'Skill' && detail) bump(skills, detail);
    else if (name === 'Agent') bump(agents, detail || DEFAULT_SUBAGENT);
  }
  return { skills, agents };
}

// Appends the branches a session has not listed yet, keeping first-seen order.
function mergeBranches(into, id, branches) {
  const known = into.branches.get(id);
  if (!known) into.branches.set(id, [...branches]);
  else for (const b of branches) if (!known.includes(b)) known.push(b);
}

// Folds each row set's per-session summaries into the running maps, in walk order.
// This runs for every row set in range or not: a session title or branch is not
// tied to the window, and an idle session's file is not skipped.
function mergeSessions(sessions, into, allTime) {
  for (const [id, s] of Object.entries(sessions)) {
    if (s.branches.length) mergeBranches(into, id, s.branches);
    const latest = into.newest.get(id);
    if (s.newestBranch && (!latest || s.newestBranch.t >= latest.t)) into.newest.set(id, s.newestBranch);
    if (s.title) into.titles.set(id, s.title);
    if (s.firstPrompt && !into.firstPrompts.has(id)) into.firstPrompts.set(id, s.firstPrompt);
    // A windowed scan cannot split one session's lifetime total across days, and
    // charging the whole of it to the window would overstate every short range.
    if (allTime && s.reportedCost != null && s.reportedCost > (into.reported.get(id) || 0)) into.reported.set(id, s.reportedCost);
  }
}

// A full-day axis keeps the live Today chart's bars stationary as the day fills
// in, instead of rescaling every bar on each new hour. Hours with no usage render
// as real gaps. `midnight` is the same value the cutoff used, so a scan that
// crosses midnight cannot key its entries to one day and its filler slots to the
// next. hourSlots (lib/dates.js) explains the 23-key spring-forward day.
//
// Day buckets run unbroken from the first day with usage to today. Charts give
// each bucket the same width, so a missing idle day would squeeze the calendar.
// With every day present, an idle day shows as a gap.
function fillAxis(dailyMap, bucket, midnight) {
  if (bucket === 'hour') {
    for (const key of hourSlots(midnight)) {
      if (!dailyMap.has(key)) dailyMap.set(key, emptyBucket(key));
    }
  }
  if (bucket === 'day' && dailyMap.size) {
    const first = [...dailyMap.keys()].sort()[0];
    const today = localDateStr(new Date(midnight));
    const d = new Date(first + 'T00:00:00'); // a date-time string without a zone parses as local time
    for (let key = first; key <= today; d.setDate(d.getDate() + 1), key = localDateStr(d)) {
      if (!dailyMap.has(key)) dailyMap.set(key, emptyBucket(key));
    }
  }
}

// What a prompt-cache rebuild cost over reading the same tokens from the cache: the
// call's price minus its price with the whole cache write counted as cache reads.
// Null for an unpriced model, so the page shows no amount instead of $0.00.
function rebuildPremium(usage, model, t, cost, priced) {
  if (!priced) return null;
  const asRead = {
    ...usage,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    cache_read_input_tokens: (usage.cache_read_input_tokens || 0) + cacheWriteTokens(usage).total,
  };
  return cost - costForUsage(asRead, model, t).cost;
}

// The output the mod recorded for each subagent step (lib/agent-steps.js), by
// stepKey. Taken from every row set, whatever the range: the steps only correct
// calls, and each call is still range-checked on its own.
function recordedOutputs(entries) {
  const recorded = new Map();
  for (const rows of entries) {
    for (const s of rows.agentSteps || []) recorded.set(stepKey(s.agentId, s.input, s.cacheWrite, s.cacheRead), s.output);
  }
  return recorded;
}

// The running totals of one aggregate call. `cutoff` is the window start, or null
// for all time. addRows takes the rows of one row set. mergeSessions takes the
// per-session summaries of one row set. result builds the object aggregate returns.
function createAccumulator({ cutoff, bucket, recorded = new Map() }) {
  // A row with no timestamp is inside every range, as an error or edit line with no
  // timestamp was before.
  const inRange = (t) => cutoff == null || t == null || t >= cutoff;

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
  // Thinking tokens are part of output. thinkingOutput is the output of the calls
  // that report thinking, so thinking / thinkingOutput is a share of those calls only.
  let totalThinking = 0;
  let totalThinkingOutput = 0;
  let totalThinkingCost = 0;
  let thinkingCalls = 0;
  const sessionIds = new Set();
  let apiCalls = 0;
  const seenToolIds = new Set(); // dedupe key: a tool_use block's own `id`
  // id -> { name, detail } for every tool_use, and the ids whose tool_result came
  // back with is_error, with that result's text. A result sits on a later line than
  // its call, and files are walked in directory order rather than chronological
  // order, so the two are joined after the walk instead of during it.
  const toolById = new Map();
  const toolErrors = new Map(); // tool_use id -> { text, t }

  // sessionId -> { added, removed } from Edit and Write results, for the Live
  // sessions panel's Lines column.
  const linesBySession = new Map();
  const seenEditIds = new Set(); // dedupe key: a tool_result's tool_use_id

  // Claude Code tags each assistant line with the skill that was active and the
  // subagent type that made the call. Neither is present on most lines, so these
  // are shares of total cost, not a partition of it. `threads` is a partition.
  const skillCost = new Map();
  const agentCost = new Map();
  const threads = { main: 0, subagent: 0 };

  const context = { over: 0, under: 0 };
  // Subagent calls in range whose transcript has no final usage line, and how many of
  // them a recorded step corrected. A step that retried inside one request reports
  // summed input counts and matches nothing, so the gap shows here.
  let noFinalCalls = 0;
  let noFinalCorrected = 0;

  // A subagent response whose transcript never got its final usage line records the
  // stream-start output_tokens. The mod's record of the same step, matched on the
  // agent and the input-side counts, which do not change while a response streams,
  // holds the real figure.
  function usageOf(row) {
    const { usage } = row;
    if (!row.noFinal || !row.agentId) return usage;
    noFinalCalls += 1;
    const recordedOutput = recorded.get(stepKey(row.agentId, usage.input_tokens || 0, usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0));
    if (!(recordedOutput > (usage.output_tokens || 0))) return usage;
    noFinalCorrected += 1;
    return { ...usage, output_tokens: recordedOutput };
  }

  // Compact per-call and per-prompt records for /api/changes, and lines changed per
  // session for /api/sessions/live. They stay on the server: server.js strips
  // `efficiency` before sending a summary.
  const calls = [];
  const prompts = [];
  const seenPromptIds = new Set(); // a resumed session copies earlier lines into its new file

  // Slash commands typed in the range, by name, for the Skills counts.
  const commandCounts = new Map();
  const seenCommandIds = new Set(); // a resumed session copies earlier lines into its new file

  // Per-session summaries across all row sets. `reported` is Claude Code's own
  // running cost counter per session. It includes API calls that never get a
  // transcript line - session titles, compaction summaries, background work - so it
  // runs above anything priced from requests. Kept separate from totalCost, which has
  // to stay equal to the sum of the daily, per-model and skill/agent/thread
  // breakdowns, all of which key off a real request.
  const summaries = { branches: new Map(), newest: new Map(), titles: new Map(), firstPrompts: new Map(), reported: new Map() };

  function record(row) {
    const { model } = row;
    const usage = usageOf(row);
    const t = row.t;
    const when = new Date(t);
    sessionIds.add(row.sessionId);
    apiCalls += 1;

    // Priced at the record's own time, so a price change applies only from its
    // effective date and older usage keeps the price it had.
    const { cost, priced, familyRate } = costForUsage(usage, model, t);

    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    // The same count costForUsage charges for.
    const write = cacheWriteTokens(usage);
    const cacheCreate = write.total;
    const cacheRead = usage.cache_read_input_tokens || 0;
    // Most subagent calls since Claude Code 2.1.280 have no thinking_tokens. Such a
    // call adds to none of the thinking sums, so it does not pull the share down.
    const thinking = usage.output_tokens_details?.thinking_tokens;
    const hasThinking = typeof thinking === 'number';
    const rate = hasThinking && priced ? outputRate(usage, model, t) : null;
    const thinkingCost = rate == null ? 0 : thinking * rate;
    if (hasThinking) {
      totalThinking += thinking;
      totalThinkingOutput += output;
      totalThinkingCost += thinkingCost;
      thinkingCalls += 1;
    }

    totalCost += cost;
    threads[row.sidechain ? 'subagent' : 'main'] += cost;
    const contextTokens = input + cacheRead + cacheCreate;
    context[contextTokens > LARGE_CONTEXT_TOKENS ? 'over' : 'under'] += cost;
    if (row.attributionSkill) skillCost.set(row.attributionSkill, (skillCost.get(row.attributionSkill) || 0) + cost);
    if (row.attributionAgent) agentCost.set(row.attributionAgent, (agentCost.get(row.attributionAgent) || 0) + cost);
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

    if (!dailyMap.has(day)) dailyMap.set(day, emptyBucket(day));
    const slot = dailyMap.get(day);
    slot.input += input;
    slot.output += output;
    slot.cacheCreate += cacheCreate;
    slot.cacheRead += cacheRead;
    slot.cost += cost;
    if (hasThinking) {
      slot.thinking += thinking;
      slot.thinkingOutput += output;
      slot.thinkingCost += thinkingCost;
    }

    if (isRealModel(model)) {
      const family = familyFor(model);
      slot.byModel[family] = (slot.byModel[family] || 0) + input + output + cacheCreate + cacheRead;
      slot.costByModel[family] = (slot.costByModel[family] || 0) + cost;

      // priceFor depends only on the model name, so the first call's priced and
      // familyRate flags hold for every call of the same model. familyRate is
      // stored only when true, so a model with its own price has the same shape
      // as before.
      if (!modelMap.has(model)) modelMap.set(model, { model, family, cost: 0, tokens: 0, thinking: 0, thinkingOutput: 0, thinkingCost: 0, priced, ...familyRateFlag(familyRate) });
      const m = modelMap.get(model);
      m.cost += cost;
      m.tokens += input + output + cacheCreate + cacheRead;
      if (hasThinking) {
        m.thinking += thinking;
        m.thinkingOutput += output;
        m.thinkingCost += thinkingCost;
      }
    }

    calls.push({
      t,
      sessionId: row.sessionId,
      main: !row.sidechain,
      model: isRealModel(model) ? model : null,
      version: row.version,
      context: input + cacheCreate + cacheRead,
      cacheRead,
      // Cache write tokens by lifetime, for the cache countdown in lib/sessions.js.
      write5m: write.write5m,
      write1h: write.write1h,
      output,
      // null when the call does not report thinking, for lib/efficiency.js stats().
      thinking: hasThinking ? thinking : null,
      cost,
      tools: row.tools,
      ...(row.rebuild ? { rebuild: { ...row.rebuild, premium: rebuildPremium(usage, model, t, cost, priced) } } : {}),
    });
  }

  function addCalls(rows) {
    for (const row of rows.calls) {
      if (!inRange(row.t)) continue;
      if (row.key) {
        if (seen.has(row.key)) continue; // the same response, also copied into another session file
        seen.add(row.key);
      }
      record(row);
    }
  }

  function addToolUses(rows) {
    for (const use of rows.toolUses) {
      if (!inRange(use.t) || seenToolIds.has(use.key)) continue;
      seenToolIds.add(use.key);
      toolById.set(use.key, { name: use.name, detail: use.detail, model: use.model });
    }
  }

  // The last write wins, so a result that appears in two files keeps the later one.
  function addErrors(rows) {
    for (const e of rows.errors) {
      if (inRange(e.t)) toolErrors.set(e.toolUseId, { text: e.text, t: e.t || 0 });
    }
  }

  function addEdits(rows) {
    for (const e of rows.edits) {
      if (!inRange(e.t) || seenEditIds.has(e.toolUseId)) continue;
      seenEditIds.add(e.toolUseId);
      const total = linesBySession.get(e.sessionId) || { added: 0, removed: 0 };
      total.added += e.added;
      total.removed += e.removed;
      linesBySession.set(e.sessionId, total);
    }
  }

  function addPrompts(rows) {
    for (const p of rows.prompts) {
      if (!inRange(p.t) || seenPromptIds.has(p.id)) continue;
      seenPromptIds.add(p.id);
      prompts.push({ t: p.t, sessionId: p.sessionId });
    }
  }

  function addCommands(rows) {
    for (const c of rows.commands) {
      if (!inRange(c.t) || seenCommandIds.has(c.id)) continue;
      seenCommandIds.add(c.id);
      commandCounts.set(c.name, (commandCounts.get(c.name) || 0) + 1);
    }
  }

  // The rows of one row set that fall inside the range, each kind deduped against
  // what earlier row sets already contributed.
  function addRows(rows) {
    addCalls(rows);
    addToolUses(rows);
    addErrors(rows);
    addEdits(rows);
    addPrompts(rows);
    addCommands(rows);
  }

  // `meta` is built by aggregate, which counts the row sets.
  function result({ midnight, meta }) {
    fillAxis(dailyMap, bucket, midnight);

    // Every key added to toolById is one it hadn't seen before - seenToolIds guards
    // against a second entry for the same tool_use - so the map's size is exactly the
    // same count a manual toolCalls++ would have made.
    const toolCalls = toolById.size;
    const { tools, toolTotals } = summariseTools(toolById, toolErrors);

    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const models = [...modelMap.values()].sort((a, b) => b.cost - a.cost);

    // Rows exist for names with attributed cost only. A skill called in the range
    // whose calls carried no attribution has no row, and a row whose skill was
    // called before the range has 0 invocations.
    const invoked = invocationCounts(toolById, commandCounts);
    const byCost = (map, counts) =>
      [...map].map(([name, cost]) => ({ name, cost, invocations: counts.get(name) || 0 })).sort((a, b) => b.cost - a.cost);

    const totalTokens = totalInput + totalOutput + totalCacheCreate + totalCacheRead;
    const cacheEligible = totalInput + totalCacheCreate + totalCacheRead; // tokens that could have been cache reads
    const cacheEfficiency = cacheEligible > 0 ? totalCacheRead / cacheEligible : 0;
    const { reported } = summaries;

    return {
      meta: { ...meta, noFinalCalls, noFinalCorrected },
      tools,
      toolTotals,
      summary: {
        totalCost,
        totalTokens,
        totalInput,
        totalOutput,
        totalCacheCreate,
        totalCacheRead,
        cacheEfficiency,
        unpricedTokens,
        thinking: totalThinking,
        thinkingOutput: totalThinkingOutput,
        thinkingCost: totalThinkingCost,
        thinkingCalls,
        sessions: sessionIds.size,
        apiCalls,
        toolCalls,
        toolErrors: toolErrors.size,
        // null on a windowed scan, where the figure would not be comparable.
        reportedCost: cutoff == null ? [...reported.values()].reduce((a, b) => a + b, 0) : null,
        reportedSessions: reported.size,
        // The "of M" in "over N of M sessions". A session can write a cost-state
        // line before any response logs usage, so it is in `reported` but not in
        // sessionIds. Both key on sessionId, so the union counts it once.
        reportedSessionsOf: cutoff == null ? new Set([...sessionIds, ...reported.keys()]).size : null,
      },
      daily,
      activity,
      models,
      skills: byCost(skillCost, invoked.skills),
      subagents: byCost(agentCost, invoked.agents),
      threads,
      context,
      contextThreshold: LARGE_CONTEXT_TOKENS,
      efficiency: {
        calls,
        prompts,
        linesBySession: Object.fromEntries(linesBySession),
        titleBySession: Object.fromEntries(summaries.titles),
        branchesBySession: Object.fromEntries(summaries.branches),
        branchBySession: Object.fromEntries([...summaries.newest].map(([id, v]) => [id, v.branch])),
        firstPromptBySession: Object.fromEntries(summaries.firstPrompts),
      },
    };
  }

  return {
    addRows,
    mergeSessions: (sessions) => mergeSessions(sessions, summaries, cutoff == null),
    result,
  };
}

/**
 * Turns the row sets of many transcripts into the dashboard's summary object:
 * token usage and estimated cost by day and by model, restricted to the last `days`
 * days (or all time if days is null). `entries` is a list of extractFile results in
 * walk order, and walk order decides which duplicate wins. The cutoff is applied to
 * each row before any dedupe, so a row outside the range never hides one inside it.
 */
function aggregate(entries, { days = 30, bucket = 'day', now = Date.now(), projectsDir } = {}) {
  // One `now` for both values, so a run across midnight cannot take its window
  // start from one day and today's date from the next.
  const midnight = windowStart('today', now);
  const cutoff = windowStart(days, now);
  const acc = createAccumulator({ cutoff, bucket, recorded: recordedOutputs(entries) });
  let scannedFiles = 0; // transcript row sets; a step file is not a session file
  let unreadableFiles = 0; // transcript row sets whose read failed
  for (const rows of entries) {
    if (rows.agentSteps) continue;
    scannedFiles += 1;
    if (!rows.ok) unreadableFiles += 1;
    acc.mergeSessions(rows.sessions);
    // A row set whose newest row is before the cutoff has nothing in range. This
    // replaces the old skip on a file's mtime.
    if (cutoff != null && rows.maxT != null && rows.maxT < cutoff) continue;
    acc.addRows(rows);
  }
  return acc.result({
    midnight,
    meta: { projectsDir, dirExists: projectsDir ? fs.existsSync(projectsDir) : false, scannedFiles, unreadableFiles },
  });
}

module.exports = { aggregate, summariseTools, ERROR_CAUSES };
