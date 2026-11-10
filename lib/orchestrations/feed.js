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
function inputsOnLine(raw, name) {
  try {
    const content = JSON.parse(raw)?.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b?.type === 'tool_use' && b.name === name).map((b) => b.input ?? {});
  } catch {
    return [];
  }
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

function describeBash(parsed, command, line) {
  const merge = parsed.merges.find((m) => m.line === line);
  if (merge) return entry('✓', `Merged Task ${merge.task}`);
  const created = [...command.matchAll(WT_CREATE)][0];
  if (created) return entry('+', `Created worktree ${created[1].replace(/^["']|["']$/g, '')}`);
  const checked = TRANSCRIPT_INDEX_STEPS.exec(command);
  if (checked) {
    const agent = parsed.agents.find((a) => checked[1].includes(a.agentId));
    const label = agent ? taskLabel(agent.task) : null;
    return entry('·', label ? `Checked ${label}'s steps` : "Checked a worker's steps");
  }
  return null;
}

// One tool call as { glyph, text, detail }, or null when the feed leaves it out.
function describeTool(parsed, tool, input, line, wroteImage = false) {
  switch (tool) {
    case 'Agent':
      return describeAgent(parsed, input, line);
    case 'SendMessage': {
      const agent = parsed.agents.find((a) => a.agentId === input.to);
      if (!agent) return null;
      const label = taskLabel(agent.task);
      return entry('↗', label ? `Steered ${label}` : 'Steered agent', typeof input.summary === 'string' ? input.summary : '');
    }
    case 'Monitor': {
      const task = TASK_IN_TEXT.exec(String(input.description ?? ''));
      return entry('·', task ? `Watching Task ${task[1]}` : 'Watching workers');
    }
    case 'Bash':
      return typeof input.command === 'string' ? describeBash(parsed, input.command, line) : null;
    case 'Write':
    case 'Edit':
      if (!isImagePath(parsed, input.file_path)) return null;
      return entry('◆', tool === 'Write' && !wroteImage ? 'Wrote the context image' : 'Updated the image');
    case 'Skill':
      return typeof input.skill === 'string' ? entry('◆', `Loaded ${input.skill}`) : null;
    default:
      return null;
  }
}

// The most recent `limit` described steps, newest first. `lines` are the
// orchestrator's raw transcript lines and `parsed` is parseOrchestrator(lines).
function actionFeed(lines, parsed, { limit = 30 } = {}) {
  const seen = new Map();
  const out = [];
  let wroteImage = false;
  for (const step of stepsOf(lines, 1, lines.length)) {
    let described = null;
    if (step.kind === 'user') {
      described = entry('›', `You: ${flat(step.text).slice(0, 60)}`);
    } else if (step.kind === 'tool' && step.tool) {
      const key = `${step.line}:${step.tool}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const input = inputsOnLine(lines[step.line - 1], step.tool)[n] ?? {};
      described = describeTool(parsed, step.tool, input, step.line, wroteImage);
      if (described && described.text === 'Wrote the context image') wroteImage = true;
    }
    if (described) out.push({ at: step.time ?? '', ...described, line: step.line });
  }
  return out.reverse().slice(0, limit);
}

// The one-line box at the top of the tab. `steps` is stepsOf over the
// orchestrator's lines. `activity` is { state, tool, since } or null when the
// activity setting is off.
function nowLine(parsed, steps, activity, live) {
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
  const described = describeTool(parsed, tool.tool, inputFromStep(parsed, tool), tool.line);
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
