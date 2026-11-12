'use strict';

// Describes an orchestrator's own steps in plain words: the "Orchestrator actions"
// feed and the one-line "Now" box. Merges come from parsed.merges, so the feed and
// parseOrchestrator agree on what counts as "Merged Task N".

const { stepsOf } = require('../transcript-index.js');
const { IMAGE_WRITE, WT_CREATE, TASK_IN_TEXT } = require('./parse.js');

const TRANSCRIPT_INDEX_STEPS = /transcript-index\s+(\S+)[^\n]*--steps/;

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const entry = (glyph, text, detail = '') => ({ glyph, text, detail });

// The input of each tool_use block named `name` on one transcript line, in order.
// `parsedLines` holds each line's content blocks (null when unreadable) so one
// raw line is parsed at most once per call that shares the map.
function inputsOnLine(lines, lineNo, name, parsedLines) {
  let content = parsedLines.get(lineNo);
  if (content === undefined) {
    try {
      const c = JSON.parse(lines[lineNo - 1])?.message?.content;
      content = Array.isArray(c) ? c : null;
    } catch {
      content = null;
    }
    parsedLines.set(lineNo, content);
  }
  if (!content) return [];
  return content.filter((b) => b?.type === 'tool_use' && b.name === name).map((b) => b.input ?? {});
}

// The raw input of a tool step, or null when its line cannot be read. `n` is the
// step's position among the steps of the same tool on that line.
function rawInput(lines, step, n, parsedLines) {
  return inputsOnLine(lines, step.line, step.tool, parsedLines)[n] ?? null;
}

function taskLabel(task) {
  return task === null || task === undefined ? null : `Task ${task}`;
}

function isImagePath(parsed, file) {
  return typeof file === 'string' && (file === parsed.imagePath || IMAGE_WRITE.test(file)) && !file.endsWith('.feedback.md');
}

function describeAgent(parsed, input, line) {
  const description = typeof input.description === 'string' ? input.description : '';
  const agent = parsed.agents.find((a) => a.line === line && a.description === description) ?? parsed.agents.find((a) => a.line === line);
  if (!agent) return entry('▸', 'Started agent', description);
  const label = taskLabel(agent.task);
  if (agent.role === 'worker') return entry('▸', label ? `Started ${label} worker` : 'Started worker', agent.files.join(', '));
  if (agent.role === 'reviewer') return entry('◐', label ? `Started review of ${label}` : 'Started review');
  return entry('▸', 'Started agent', description);
}

// A Monitor names the agent it watches by its transcript, agent-<agentId>.jsonl. In a
// claim run the description's number is dispatch order, so the watched agent's
// resolved task wins. The description is used when no single agent matches.
// parsed.watchAgents holds every session's agents, because a watch re-armed after a
// reset names a worker an earlier session started.
function monitorEntry(parsed, input) {
  const command = String(input.command ?? '');
  const matches = (parsed.watchAgents ?? parsed.agents).filter((a) => command.includes(`agent-${a.agentId}.jsonl`));
  const agent = matches.length === 1 ? matches[0] : null;
  const label = agent ? taskLabel(agent.task) : null;
  if (label) return entry('·', `Watching ${label}`);
  if (agent?.claimKind) return entry('·', agent.role === 'reviewer' ? 'Watching a reviewer' : 'Watching a worker');
  const task = TASK_IN_TEXT.exec(String(input.description ?? ''));
  return entry('·', task ? `Watching Task ${task[1]}` : 'Watching workers');
}

// A Bash call as a list of entries: its merges, its worktree creations, or both (merges
// first). A call with neither can be a transcript-index check.
function describeBash(parsed, command, line) {
  const out = [];
  const merged = [...new Set(parsed.merges.filter((m) => m.line === line).map((m) => m.task))];
  if (merged.length) out.push(entry('✓', `Merged Task${merged.length > 1 ? 's' : ''} ${merged.join(', ')}`));
  const created = [...command.matchAll(WT_CREATE)].map((m) => m[1].replace(/^["']|["']$/g, ''));
  if (created.length) out.push(entry('+', `Created worktree${created.length > 1 ? 's' : ''} ${created.join(', ')}`));
  if (out.length) return out;
  const checked = TRANSCRIPT_INDEX_STEPS.exec(command);
  if (checked) {
    const agent = parsed.agents.find((a) => checked[1].includes(a.agentId));
    const label = agent ? taskLabel(agent.task) : null;
    out.push(entry('·', label ? `Checked ${label}'s steps` : "Checked a worker's steps"));
  }
  return out;
}

// One tool call as a list of { glyph, text, detail }, empty when the feed leaves it out.
function describeTool(parsed, tool, input, line, wroteImage = false) {
  const one = (e) => (e ? [e] : []);
  switch (tool) {
    case 'Agent':
      return [describeAgent(parsed, input, line)];
    case 'SendMessage': {
      const agent = parsed.agents.find((a) => a.agentId === input.to);
      if (!agent) return [];
      const label = taskLabel(agent.task);
      return [entry('↗', label ? `Steered ${label}` : 'Steered agent', typeof input.summary === 'string' ? input.summary : '')];
    }
    case 'Monitor':
      return [monitorEntry(parsed, input)];
    case 'Bash':
      return typeof input.command === 'string' ? describeBash(parsed, input.command, line) : [];
    case 'Write':
    case 'Edit':
      if (!isImagePath(parsed, input.file_path)) return [];
      return [entry('◆', tool === 'Write' && !wroteImage ? 'Wrote the context image' : 'Updated the image')];
    case 'Skill':
      return one(typeof input.skill === 'string' ? entry('◆', `Loaded ${input.skill}`) : null);
    default:
      return [];
  }
}

// The most recent `limit` described steps, newest first. `lines` are the
// orchestrator's raw transcript lines and `parsed` is parseOrchestrator(lines). `steps`
// is stepsOf(lines, 1, lines.length) when the caller already has it.
function actionFeed(lines, parsed, { limit = 30, steps = stepsOf(lines, 1, lines.length) } = {}) {
  const seen = new Map();
  const parsedLines = new Map();
  const out = [];
  let wroteImage = false;
  for (const step of steps) {
    let described = [];
    if (step.kind === 'user') {
      described = [entry('›', `You: ${flat(step.text).slice(0, 60)}`)];
    } else if (step.kind === 'tool' && step.tool) {
      const key = `${step.line}:${step.tool}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      described = describeTool(parsed, step.tool, rawInput(lines, step, n, parsedLines) ?? {}, step.line, wroteImage);
      if (described.some((d) => d.text === 'Wrote the context image')) wroteImage = true;
    }
    // The feed is reversed below, so a step's entries go in last-first to read in order.
    for (const d of [...described].reverse()) out.push({ at: step.time ?? '', ...d, line: step.line });
  }
  // stepsOf skips the isMeta rows the mod appends, so each dashboard steer comes from
  // parsed.notes. A note is a feed entry whether or not a worker matched it.
  for (const note of parsed.notes) {
    const label = taskLabel(note.task);
    out.push({ at: note.at, ...entry('↗', label ? `You steered ${label}` : 'You steered a worker', note.summary), line: note.line });
  }
  out.sort((a, b) => a.line - b.line);
  return out.reverse().slice(0, limit);
}

// The one-line box at the top of the tab. `steps` is stepsOf over the
// orchestrator's lines. `activity` is { state, tool, since } or null when the
// activity setting is off. `lines` are the orchestrator's raw lines. When given,
// the tool input is read from the raw line, as actionFeed does, instead of being
// rebuilt from the step's text.
function nowLine(parsed, steps, activity, live, lines = null) {
  if (!live) {
    return { state: parsed.finishing ? 'finished' : 'idle', text: parsed.finishing ? 'Finished' : 'Idle', detail: '', since: null };
  }
  const last = steps.at(-1);
  const lastText = [...steps].reverse().find((s) => s.kind === 'text' && !s.tool);
  const state = activity ? activity.state : last && last.kind === 'text' ? 'waiting' : 'working';
  const since = typeof activity?.since === 'number' ? new Date(activity.since).toISOString() : (last?.time ?? null);
  if (state === 'waiting') {
    return { state: 'waiting', text: 'Waiting for you', detail: flat(lastText?.text).slice(0, 140), since };
  }
  const tool = [...steps].reverse().find((s) => s.kind === 'tool' && s.tool);
  if (!tool) return { state: 'working', text: 'Working', detail: '', since };
  const same = steps.filter((s) => s.kind === 'tool' && s.line === tool.line && s.tool === tool.tool);
  const raw = lines ? rawInput(lines, tool, same.indexOf(tool), new Map()) : null;
  const described = describeTool(parsed, tool.tool, raw ?? inputFromStep(parsed, tool), tool.line)[0];
  if (described) return { state: 'working', text: described.text, detail: flat(described.detail).slice(0, 140), since };
  return { state: 'working', text: 'Working', detail: flat(`${tool.tool} ${tool.text}`).slice(0, 140), since };
}

// A step keeps only the main field of its tool input, so rebuild the input
// fields describeTool reads. A SendMessage step has no such field, so its
// recipient and summary come from the parsed.steers entry on the same line.
function inputFromStep(parsed, step) {
  switch (step.tool) {
    case 'SendMessage': {
      const steer = parsed.steers.find((st) => st.line === step.line);
      return steer ? { to: steer.to, summary: steer.summary } : {};
    }
    case 'Agent':
    case 'Monitor':
      return { description: step.text };
    case 'Bash':
      return { command: step.text };
    case 'Skill':
      return { skill: step.text };
    case 'Write':
    case 'Edit':
      return { file_path: step.text };
    default:
      return {};
  }
}

module.exports = { actionFeed, nowLine };
