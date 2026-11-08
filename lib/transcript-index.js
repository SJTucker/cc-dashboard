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
  for (const key of ['file_path', 'notebook_path', 'command', 'skill', 'description', 'pattern', 'url']) {
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
        // A worker's final report. It is a text step, and its tool name stays on it so a
        // watcher can tell the report from other text.
        else if (b.type === 'tool_use' && b.name === 'SubagentHandback') step('text', b.name, String(b.input?.message ?? ''));
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

const STEP_LABEL = { text: 'TEXT', msg: 'MSG', user: 'USER' };

// One step as `<line> <HH:MM:SS> <body>` on a single line, the time in UTC.
function stepLine(s) {
  const time = s.time?.slice(11, 19) || '--:--:--';
  const body = flat(s.text);
  let label;
  if (s.kind === 'tool') label = `${s.tool} ${body.slice(0, 120)}`;
  else if (s.kind === 'error') label = `ERROR ${s.tool ?? '?'}: ${body.slice(0, 160)}`;
  else label = `${STEP_LABEL[s.kind]} ${body.slice(0, 160)}`;
  return `${s.line} ${time} ${label.trimEnd()}`;
}

// The last n steps of the whole file, oldest first, one line each.
function recentSteps(lines, n) {
  return stepsOf(lines, 1, lines.length).slice(-n).map(stepLine);
}

// The context size at the last assistant record that reports usage: its input
// tokens plus the cache reads and writes. Null when no record reports usage.
function contextTokens(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    const p = parseAll([lines[i]])[0];
    const u = p?.type === 'assistant' ? p.message?.usage : null;
    if (!u || typeof u !== 'object') continue;
    return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return null;
}

// Whether an edited path is one of the task's files. A task file can be given
// relative to the worktree, so a path ending in /<file> matches too.
function isTaskFile(file, files) {
  return files.some((f) => file === f || file.endsWith('/' + f));
}

// A DRIFT event for the first edit of each path outside the task's files, or null.
function driftEvent(s, seen, files) {
  if (!files || s.kind !== 'tool' || !EDIT_TOOLS.has(s.tool) || !s.text) return null;
  if (isTaskFile(s.text, files) || seen.drifted.has(s.text)) return null;
  seen.drifted.add(s.text);
  return `DRIFT edit outside task files: ${s.text}`;
}

// A STUCK event on the third error in a row with the same tool and text, or null.
function stuckEvent(s, seen) {
  const key = `${s.tool ?? '?'} ${flat(s.text).slice(0, 60)}`;
  seen.failures = seen.failures?.key === key ? { key, count: seen.failures.count + 1 } : { key, count: 1 };
  return seen.failures.count === 3 ? `STUCK ${key} failed 3 times in a row` : null;
}

// The events in the steps from seen.next on, for watchEvents. A SubagentHandback
// sets seen.report; watchEvents reports it last, as DONE.
function stepEvents(steps, seen, files) {
  const events = [];
  for (const s of steps) {
    if (seen.report !== null) break;
    const event = s.kind === 'error' ? stuckEvent(s, seen) : driftEvent(s, seen, files);
    if (event) events.push(event);
    if (s.kind === 'msg') events.push(`MSG landed at line ${s.line}`);
    if (s.kind === 'text') seen.lastText = s.text;
    if (s.tool === 'SubagentHandback') seen.report = s.text;
  }
  return events;
}

// The new events in a worker transcript since the last poll, for --watch. Pure:
// seen is what earlier polls saw (null on the first), returned updated. Each event
// is reported once per occurrence, so a watch that polls every two seconds does
// not repeat itself. opts.finished is the meta file's finished flag; it ends the
// watch when the worker stopped without a SubagentHandback.
function watchEvents(lines, seen, opts) {
  const prev = seen ?? { next: 1, drifted: new Set(), failures: null, overBudget: false, lastText: '', report: null, done: false };
  const state = { ...prev, drifted: new Set(prev.drifted) };
  if (state.done) return { events: [], seen: state, done: true };
  const events = lines.length >= state.next ? stepEvents(stepsOf(lines, state.next, lines.length), state, opts.files) : [];
  state.next = Math.max(state.next, lines.length + 1);
  if (opts.budget != null && !state.overBudget) {
    const tokens = contextTokens(lines);
    if (tokens !== null && tokens > opts.budget) {
      state.overBudget = true;
      events.push(`BUDGET context ${tokens} tokens, over ${opts.budget}`);
    }
  }
  if (state.report !== null || opts.finished) {
    state.done = true;
    events.push(`DONE ${flat(state.report ?? state.lastText).slice(0, 160)}`.trimEnd());
  }
  return { events, seen: state, done: state.done };
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
      // Claude Code puts an unanswered prompt back in the input box. Sent again as
      // it was, it continues its turn. Edited first, it starts a turn of its own,
      // so the prompt actually sent stays in the index.
      const resubmitted = cur && !cur.replied && cur.parentUuid !== null && p.parentUuid === cur.parentUuid && prompt === cur.prompt;
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

module.exports = { buildIndex, stepsOf, recentSteps, contextTokens, watchEvents, renderIndex, agentTranscriptPath };
