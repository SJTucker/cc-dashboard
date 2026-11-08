'use strict';

const { isTypedPrompt, midTurnPromptText, promptText, bashGroup, resultText } = require('./transcript-lines');

// The index of one transcript: its turns with the 1-based line ranges they cover,
// and per turn the files touched, commands run and subagents launched. Line numbers
// count every line of the file, parsed or not, so they agree with `sed -n` and
// `grep -n`. bin/transcript-index renders it after each main-thread turn.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DOC_DIRS = ['/docs/superpowers/', '/.claude/handoffs/'];
const COORDINATOR_LEAD = /^The coordinator sent a message while you were working:\n/;
const RESUMED_FROM = /^Read (\S+\.jsonl), the transcript of an earlier Claude Code session/;

// Each line parsed, or null for a blank line or one that is not JSON. The last line
// can be cut mid-write while Claude Code is still appending to the file.
function parseAll(lines) {
  return lines.map((line) => {
    if (!line || !line.trim()) return null;
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  });
}

// A worker (subagent) transcript is told apart by its first user or assistant
// record carrying a top-level agentId. isSidechain cannot be used: other line
// types in a worker file, such as api-request, lack it. taskLine is the 0-based
// index of the worker's task prompt: its first user record with prompt text and no
// origin.
function fileKind(parsed) {
  let worker = null;
  let taskLine = -1;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p || (p.type !== 'user' && p.type !== 'assistant')) continue;
    if (worker === null) worker = Object.hasOwn(p, 'agentId');
    if (!worker) break;
    if (p.type === 'user' && !p.origin && promptText(p.message?.content) !== null) {
      taskLine = i;
      break;
    }
  }
  return { worker: worker === true, taskLine };
}

// In a main transcript, sidechain lines belong to subagents and a compact summary
// is Claude Code's own text, so neither adds to a turn.
function skipped(p, kind) {
  return !kind.worker && (p.isSidechain === true || p.isCompactSummary === true);
}

function coordinatorText(p) {
  if (p.type !== 'user' || p.origin?.kind !== 'coordinator') return null;
  const t = promptText(p.message?.content);
  return t === null ? null : t.replace(COORDINATOR_LEAD, '');
}

// The prompt that starts a turn at record p (0-based line i), or null.
function turnPrompt(p, i, kind) {
  if (kind.worker) return i === kind.taskLine ? promptText(p.message?.content) : coordinatorText(p);
  if (isTypedPrompt(p)) return promptText(p.message.content);
  return midTurnPromptText(p);
}

function blocks(p) {
  const content = p.message?.content;
  return Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
}

function toolText(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['file_path', 'command', 'skill', 'description', 'pattern', 'url']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

// Tool names by tool_use id, so an error result can name the call that failed.
function toolNames(parsed, to) {
  const names = new Map();
  for (let i = 0; i < to; i++) {
    const p = parsed[i];
    if (p?.type !== 'assistant') continue;
    for (const b of blocks(p)) if (b.type === 'tool_use') names.set(b.id, b.name);
  }
  return names;
}

// The steps of 0-based records from..to-1 (to exclusive).
function stepsIn(parsed, from, to, kind, names) {
  const steps = [];
  for (let i = from; i < to; i++) {
    const p = parsed[i];
    if (!p || skipped(p, kind)) continue;
    const line = i + 1;
    const time = typeof p.timestamp === 'string' ? p.timestamp : null;
    const step = (k, tool, t) => steps.push({ line, time, kind: k, tool, text: t });
    const prompt = turnPrompt(p, i, kind);
    if (prompt !== null) {
      step(kind.worker && i !== kind.taskLine ? 'msg' : 'user', null, prompt);
      continue;
    }
    const msg = coordinatorText(p);
    if (msg !== null) {
      step('msg', null, msg);
      continue;
    }
    if (p.type === 'assistant') {
      for (const b of blocks(p)) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) step('text', null, b.text);
        else if (b.type === 'tool_use' && b.name === 'SubagentHandback') step('text', null, String(b.input?.message ?? ''));
        else if (b.type === 'tool_use') step('tool', b.name ?? null, toolText(b.input));
      }
    } else if (p.type === 'user') {
      for (const b of blocks(p)) {
        if (b.type === 'tool_result' && b.is_error === true) step('error', names.get(b.tool_use_id) ?? null, resultText(b.content));
      }
    }
  }
  return steps;
}

// The steps of 1-based lines from..to: each prompt, assistant text, tool call,
// error result and coordinator message, in file order.
function stepsOf(lines, from, to) {
  const parsed = parseAll(lines.slice(0, to));
  return stepsIn(parsed, from - 1, to, fileKind(parsed), toolNames(parsed, to));
}

function countInto(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// Count descending; Array.prototype.sort is stable, so ties keep first appearance.
function byCount(map) {
  return [...map].sort((a, b) => b[1] - a[1]);
}

function newTurn(n, i, p, prompt) {
  return {
    n,
    startLine: i + 1,
    endLine: i + 1,
    at: typeof p.timestamp === 'string' ? p.timestamp : '',
    uuid: typeof p.uuid === 'string' ? p.uuid : null,
    prompt,
    edited: new Map(),
    read: new Set(),
    commands: new Map(),
    skills: new Set(),
    agents: [],
    errors: 0,
    lastText: null,
    // Not exported: whether to treat the next identical prompt as a resubmission.
    parentUuid: p.parentUuid ?? null,
    replied: false,
  };
}

function finishTurn(t, endLine, parsed, kind, names) {
  const texts = stepsIn(parsed, t.startLine - 1, endLine, kind, names).filter((s) => s.kind === 'text');
  return {
    n: t.n,
    startLine: t.startLine,
    endLine,
    at: t.at,
    uuid: t.uuid,
    prompt: t.prompt,
    edited: byCount(t.edited),
    read: [...t.read],
    commands: byCount(t.commands),
    skills: [...t.skills],
    agents: t.agents,
    errors: t.errors,
    lastText: texts.length ? texts.at(-1).text.replace(/\s+/g, ' ').trim() : null,
  };
}

function updateFacts(facts, p) {
  if (p.type === 'ai-title' && typeof p.aiTitle === 'string') facts.title = p.aiTitle;
  if (typeof p.gitBranch === 'string' && p.gitBranch) facts.branch = p.gitBranch;
  if (facts.cwd === null && typeof p.cwd === 'string') facts.cwd = p.cwd;
  if (facts.sessionId === null && typeof p.sessionId === 'string') facts.sessionId = p.sessionId;
  if (typeof p.timestamp === 'string') {
    facts.startedAt ??= p.timestamp;
    facts.updatedAt = p.timestamp;
  }
}

function buildIndex(lines) {
  const parsed = parseAll(lines);
  const kind = fileKind(parsed);
  const names = toolNames(parsed, parsed.length);
  const facts = { title: null, branch: null, cwd: null, startedAt: null, updatedAt: null, sessionId: null, resumedFrom: null };
  const turns = [];
  const compactions = [];
  const written = new Set();
  const agentsById = new Map();
  let agentCount = 0;
  let cur = null;

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p) continue;
    updateFacts(facts, p);
    if (p.type === 'system' && p.subtype === 'compact_boundary') compactions.push(i + 1);
    if (skipped(p, kind)) continue;

    const prompt = turnPrompt(p, i, kind);
    if (prompt !== null) {
      const resubmitted = cur && !cur.replied && cur.parentUuid !== null && p.parentUuid === cur.parentUuid;
      if (!resubmitted) {
        if (cur) turns.push(finishTurn(cur, i, parsed, kind, names));
        cur = newTurn(turns.length + 1, i, p, prompt);
      }
      continue;
    }

    if (p.type === 'assistant') {
      if (cur) cur.replied = true;
      for (const b of blocks(p)) {
        if (b.type !== 'tool_use') continue;
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const file = typeof input.file_path === 'string' ? input.file_path : null;
        if (b.name === 'Write' && file && DOC_DIRS.some((d) => file.includes(d))) written.add(file);
        if (b.name === 'Agent') {
          const agent = {
            description: typeof input.description === 'string' ? input.description : '',
            type: typeof input.subagent_type === 'string' ? input.subagent_type : null,
            model: typeof input.model === 'string' ? input.model : null,
            agentId: null,
          };
          agentCount += 1;
          agentsById.set(b.id, agent);
          if (cur) cur.agents.push(agent);
        }
        if (!cur) continue;
        if (EDIT_TOOLS.has(b.name) && file) countInto(cur.edited, file);
        if (b.name === 'Read' && file) cur.read.add(file);
        if (b.name === 'Bash') {
          const group = bashGroup(input.command);
          if (group) countInto(cur.commands, group);
        }
        if (b.name === 'Skill' && typeof input.skill === 'string') cur.skills.add(input.skill);
      }
    } else if (p.type === 'user') {
      for (const b of blocks(p)) {
        if (b.type !== 'tool_result') continue;
        if (b.is_error === true && cur) cur.errors += 1;
        const agent = agentsById.get(b.tool_use_id);
        if (agent && typeof p.toolUseResult?.agentId === 'string') agent.agentId = p.toolUseResult.agentId;
      }
    }
  }
  if (cur) turns.push(finishTurn(cur, parsed.length, parsed, kind, names));

  const first = turns[0]?.prompt;
  const resumed = typeof first === 'string' ? RESUMED_FROM.exec(first) : null;
  facts.resumedFrom = resumed ? resumed[1] : null;

  return { facts, worker: kind.worker, lineCount: lines.length, turns, compactions, written: [...written], agentCount };
}

module.exports = { buildIndex, stepsOf };
