'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { costForUsage, priceFor, familyFor } = require('./pricing');

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

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isRealModel(model) {
  return !!model && !model.startsWith('<');
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

  const midnight = startOfToday();
  const cutoff = days === 'today' ? midnight : days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
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
  let toolCalls = 0;
  const seenToolIds = new Set(); // dedupe key: a tool_use block's own `id`

  // Claude Code tags each assistant line with the skill that was active and the
  // subagent type that made the call. Neither is present on most lines, so these
  // are shares of total cost, not a partition of it. `threads` is a partition.
  const skillCost = new Map();
  const agentCost = new Map();
  const threads = { main: 0, subagent: 0 };
  const context = { over: 0, under: 0 };

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

      // tool_use blocks frequently ride on a line AFTER the first line of an
      // API response, so they must be counted before the dedupe return below
      // drops every line but the first. Deduped on each block's own id
      // (toolu_...), not on the message/request key those lines share.
      const content = parsed.message?.content;
      if (Array.isArray(content)) {
        content.forEach((block, i) => {
          if (!block || block.type !== 'tool_use') return;
          // Real blocks carry a toolu_... id. One without falls back to the
          // response key plus its position, so duplicate stream lines still
          // collapse to one count instead of one per line.
          const key = block.id || `${parsed.message?.id}:${parsed.requestId}:${i}`;
          if (seenToolIds.has(key)) return;
          seenToolIds.add(key);
          toolCalls += 1;
        });
      }

      const msgId = parsed.message?.id;
      const reqId = parsed.requestId;
      if (msgId && reqId) {
        const key = `${msgId}:${reqId}`;
        if (seen.has(key)) return; // same API response logged across multiple stream lines
        seen.add(key);
      }

      // One session file can hold several sessions when a session is resumed,
      // so count the id rather than the file. Fall back to the path when an
      // older entry has no sessionId.
      sessionIds.add(parsed.sessionId || file);
      apiCalls += 1;

      const { cost, priced } = costForUsage(usage, model);

      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      // costForUsage reads the 5m/1h split and falls back to the flat field.
      // This has to make the same choice, or a split-only record is charged for
      // tokens that the totals report as zero.
      const split = usage.cache_creation || {};
      const cacheCreate =
        usage.cache_creation_input_tokens ||
        (split.ephemeral_5m_input_tokens || 0) + (split.ephemeral_1h_input_tokens || 0);
      const cacheRead = usage.cache_read_input_tokens || 0;

      totalCost += cost;
      threads[parsed.isSidechain ? 'subagent' : 'main'] += cost;
      const contextTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
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

        if (!modelMap.has(model)) modelMap.set(model, { model, family, cost: 0, tokens: 0 });
        const m = modelMap.get(model);
        m.cost += cost;
        m.tokens += input + output + cacheCreate + cacheRead;
      }
    });
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
    },
    daily,
    activity,
    models,
    skills: byCost(skillCost),
    subagents: byCost(agentCost),
    threads,
    context,
    contextThreshold: LARGE_CONTEXT_TOKENS,
  };
}

module.exports = { scanUsage, getProjectsDir };
