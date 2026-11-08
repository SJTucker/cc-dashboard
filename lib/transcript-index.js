'use strict';

const path = require('path');
const { isTypedPrompt, midTurnPromptText, promptText, promptPreview, bashGroup, resultText } = require('./transcript-lines');

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

const CAPS = { prompt: 300, goal: 600, lastText: 300, edited: 10, overviewEdited: 10, read: 8, commands: 6 };

// Single quotes around the whole path, each embedded ' written as '\''. A path
// quoted this way pastes correctly into a shell whatever characters it holds.
function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function flat(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function cap(s, n) {
  const t = flat(s);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

// "10:04 UTC 2026-11-08" for an ISO timestamp, or null.
function utc(ts) {
  const m = typeof ts === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts) : null;
  return m ? `${m[2]} UTC ${m[1]}` : null;
}

function counted(pairs, n) {
  return pairs.slice(0, n).map(([k, c]) => `${k} (${c})`).join(', ');
}

// A worker's transcript: <project dir>/<session id>/subagents/agent-<agentId>.jsonl.
function agentTranscriptPath(transcriptPath, sessionId, agentId) {
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

function agentLine(a, transcriptPath, sessionId) {
  const kind = [a.type, a.model].filter(Boolean).join(', ');
  const head = `- "${a.description}"${kind ? ` (${kind})` : ''}`;
  return a.agentId ? `${head}: ${agentTranscriptPath(transcriptPath, sessionId, a.agentId)}` : `${head}: no agent id recorded`;
}

function turnSection(t, transcriptPath, sessionId) {
  const head = [`## Turn ${t.n}`, `lines ${t.startLine}–${t.endLine}`, utc(t.at), t.uuid].filter(Boolean).join(' · ');
  const rows = [head, '', `Prompt: ${cap(t.prompt, CAPS.prompt)}`];
  if (t.edited.length) rows.push(`Edited: ${counted(t.edited, CAPS.edited)}`);
  if (t.read.length) {
    const more = t.read.length - CAPS.read;
    rows.push(`Read: ${t.read.slice(0, CAPS.read).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
  }
  if (t.commands.length) rows.push(`Commands: ${counted(t.commands, CAPS.commands)}`);
  if (t.skills.length) rows.push(`Skills: ${t.skills.join(', ')}`);
  if (t.agents.length) rows.push('Agents:', ...t.agents.map((a) => agentLine(a, transcriptPath, sessionId)));
  if (t.errors) rows.push(`Tool errors: ${t.errors}`);
  if (t.lastText) rows.push(`Last reply: ${cap(t.lastText, CAPS.lastText)}`);
  return rows.join('\n');
}

function overview(index, transcriptPath, indexDir, sessionId) {
  const rows = ['## Overview', ''];
  const first = index.turns[0];
  if (first) rows.push(`Goal: ${cap(first.prompt, CAPS.goal)}`);
  const from = index.facts.resumedFrom;
  if (from) {
    const its = indexDir ? `; its index: ${path.join(indexDir, path.basename(from, '.jsonl') + '.md')}` : '';
    rows.push(`Resumed from: ${shellQuote(from)}${its}`);
  }
  rows.push(`Turns: ${index.turns.length}`);
  if (index.compactions.length) rows.push(`Compactions at lines: ${index.compactions.join(', ')}`);
  const edits = new Map();
  for (const t of index.turns) for (const [file, c] of t.edited) edits.set(file, (edits.get(file) ?? 0) + c);
  if (edits.size) rows.push(`Most edited: ${counted(byCount(edits), CAPS.overviewEdited)}`);
  if (index.written.length) rows.push(`Docs written: ${index.written.join(', ')}`);
  if (index.agentCount) {
    const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents') + '/';
    rows.push(`Subagents: ${index.agentCount}, transcripts in ${shellQuote(dir)}`);
  }
  return rows.join('\n');
}

// The index as Markdown: title, facts, how to read the transcript, an overview,
// then one section per turn. indexDir is where the indexes live, so a resumed
// session can name the index of the transcript it resumed from.
function renderIndex(index, transcriptPath, indexDir) {
  const { facts } = index;
  const sessionId = facts.sessionId ?? path.basename(transcriptPath, '.jsonl');
  const title = facts.title ?? (index.turns[0] ? promptPreview(index.turns[0].prompt) : sessionId);
  const span = [utc(facts.startedAt), utc(facts.updatedAt)].filter(Boolean);
  const factLine = [
    `Session ${sessionId}`,
    facts.cwd && `cwd ${facts.cwd}`,
    facts.branch && `branch ${facts.branch}`,
    span.length && `${span[0]} to ${span.at(-1)}`,
  ].filter(Boolean).join(' · ');
  const quoted = shellQuote(transcriptPath);
  const howTo = [
    '## How to read',
    '',
    'Never read the transcript whole: one line can hold a huge tool result. Each turn below names the lines it covers. Print a range with each line cut to 400 characters:',
    '',
    `    sed -n 'A,Bp' ${quoted} | cut -c1-400`,
    '',
    'Find one record by the uuid in a turn heading:',
    '',
    `    grep -n '"uuid":"<uuid>"' ${quoted}`,
  ].join('\n');
  const sections = [
    `# Transcript index: ${title}\n\n${factLine}\nTranscript: ${quoted} (${index.lineCount} lines)`,
    howTo,
    overview(index, transcriptPath, indexDir, sessionId),
    ...index.turns.map((t) => turnSection(t, transcriptPath, sessionId)),
  ];
  return sections.join('\n\n') + '\n';
}

module.exports = { buildIndex, stepsOf, renderIndex, agentTranscriptPath };
