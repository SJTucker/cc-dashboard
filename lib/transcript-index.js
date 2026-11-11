'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isTypedPrompt, midTurnPromptText, promptText, promptPreview, bashGroup, resultText } = require('./transcript-lines');

// The index of one transcript: its turns with the 1-based line ranges they cover,
// and per turn the files touched, commands run and subagents launched. Line numbers
// count every line of the file, parsed or not, so they agree with `sed -n` and
// `grep -n`. bin/transcript-index renders it after each main-thread turn.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DOC_DIRS = ['/docs/superpowers/', '/.claude/handoffs/'];
const COORDINATOR_LEAD = /^The coordinator sent a message while you were working:\n/;
const RESUMED_FROM = /^Read (?:'((?:[^']|'\\'')+\.jsonl)'|(\S+\.jsonl)), the transcript of an earlier Claude Code session/;

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
//
// prev is the result of an earlier call over the lines before these. It lets a call over
// later records carry on: a settled kind is returned as is, and an unsettled one keeps
// what it found (whether the first record is a worker's) and searches on for the task
// line. start is the index to scan from; the records before it were covered by prev.
// settled is false until the first record is seen to be a main transcript's, or a
// worker's task line is found.
function fileKind(parsed, prev = null, start = 0) {
  if (prev?.settled) return prev;
  let first = prev?.first ?? null;
  let taskLine = prev?.taskLine ?? -1;
  for (let i = start; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p || (p.type !== 'user' && p.type !== 'assistant')) continue;
    if (first === null) first = Object.hasOwn(p, 'agentId');
    if (!first) break;
    if (p.type === 'user' && !p.origin && promptText(p.message?.content) !== null) {
      taskLine = i;
      break;
    }
  }
  return { worker: first === true, first, taskLine, settled: first === false || taskLine >= 0 };
}

// In a main transcript, sidechain lines belong to subagents and a compact summary
// is Claude Code's own text, so neither adds to a turn.
function skipped(p, kind) {
  return !kind.worker && (p.isSidechain === true || p.isCompactSummary === true);
}

// A message the coordinator sent to a worker, or null. One sent after the worker
// finished resumes it as a user record. One sent while it runs lands at its next
// tool round as a queued_command attachment.
function coordinatorText(p) {
  const a = p.type === 'attachment' ? p.attachment : null;
  if (a?.type === 'queued_command' && a.origin?.kind === 'coordinator') return typeof a.prompt === 'string' ? a.prompt : null;
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

// The text Claude Code writes as a user record when the user stops a worker.
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;

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
function toolNames(parsed, to, names = new Map(), from = 0) {
  for (let i = from; i < to; i++) {
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
    if (p.type === 'assistant' && p.isApiErrorMessage === true) {
      const t = blocks(p).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
      step('apierror', null, t || String(p.error ?? ''));
    } else if (p.type === 'assistant') {
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
        else if (b.type === 'text' && INTERRUPT.test(b.text ?? '')) step('interrupt', null, b.text);
      }
    }
  }
  return steps;
}

// The steps of 1-based lines from..to: each prompt, assistant text, tool call,
// error result and coordinator message, in file order.
//
// With no ctx the lines before `from` are parsed too, to know the file's kind and the
// tool names. With a ctx object ({} on the first call), only lines from..to are parsed:
// ctx.kind and ctx.names carry what the earlier lines gave, and each call adds to them.
// A caller that passes ctx must call it with consecutive ranges, or with a ctx whose
// names cover the lines before `from`. A shallow copy of ctx that shares its names Map
// is safe, because tool_use ids are unique.
function stepsOf(lines, from, to, ctx = null) {
  if (!ctx) {
    const parsed = parseAll(lines.slice(0, to));
    return stepsIn(parsed, from - 1, to, fileKind(parsed), toolNames(parsed, to));
  }
  // Records before `from` stay holes, so line numbers and fileKind's indexes are absolute.
  const parsed = new Array(from - 1);
  for (const p of parseAll(lines.slice(from - 1, to))) parsed.push(p);
  ctx.kind = fileKind(parsed, ctx.kind, from - 1);
  ctx.names ??= new Map();
  toolNames(parsed, to, ctx.names, from - 1);
  return stepsIn(parsed, from - 1, to, ctx.kind, ctx.names);
}

const STEP_LABEL = { text: 'TEXT', msg: 'MSG', user: 'USER', interrupt: 'INTERRUPT', apierror: 'API ERROR' };

// One step as `<line> <HH:MM:SS> <body>` on a single line, the time in UTC. The
// body is cut at 120 characters for a tool call and 160 otherwise, unless full.
function stepLine(s, full) {
  const time = s.time?.slice(11, 19) || '--:--:--';
  const body = (n) => (full ? flat(s.text) : flat(s.text).slice(0, n));
  let label;
  if (s.kind === 'tool') label = `${s.tool} ${body(120)}`;
  else if (s.kind === 'error') label = `ERROR ${s.tool ?? '?'}: ${body(160)}`;
  else if (s.tool === 'SubagentHandback') label = `REPORT ${body(160)}`;
  else label = `${STEP_LABEL[s.kind]} ${body(160)}`;
  return `${s.line} ${time} ${label.trimEnd()}`;
}

// The last n steps of the whole file, oldest first, one line each.
function recentSteps(lines, n, opts = {}) {
  return stepsOf(lines, 1, lines.length).slice(-n).map((s) => stepLine(s, opts.full === true));
}

// Commands whose arguments are not files being read: they change, list or run
// things. Any other command's file arguments count as reads. board-post appends
// to the board file it is given. A for, case or select list is not read: a read
// in the loop body goes through a variable, which cannot be resolved.
const NON_READERS = new Set(['board-post', 'for', 'case', 'select', 'uv', 'uvx', 'pytest', 'poetry', 'pipenv', 'go', 'tsc', 'vitest', 'jest', 'docker', 'playwright-cli', 'pw', 'sleep', 'curl', 'wget', 'cx', 'claude', 'tar', 'zip', 'unzip', 'gzip', 'patch', 'install', 'rsync', 'scp', 'sqlite3', 'osascript', 'cd', 'ls', 'rm', 'rmdir', 'mv', 'cp', 'ln', 'touch', 'mkdir', 'chmod', 'chown', 'tee', 'wc', 'stat', 'file', 'du', 'find', 'test', '[', 'echo', 'printf', 'git', 'wt', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'deno', 'bun', 'python', 'python3', 'ruby', 'bash', 'sh', 'zsh', 'make', 'cargo', 'open', 'kill', 'which', 'type', 'source', '.', 'export']);
// A redirection that is a word of its own: >, >>, <, 2>, 2>&1, &>. All but the
// >&N form take the next word as their target.
const REDIRECT = /^(\d*>>?|<|\d*>&\d+|&>>?)$/;
const NOT_A_PATH = /[$*?`]/;
// A heredoc from its << line to the line holding only its delimiter.
const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)/g;

// The command without its heredoc bodies, which are text, not commands. An
// unterminated heredoc, or a <<< here-string, cuts the command at its <<.
function stripHeredocs(command) {
  const s = command.replace(HEREDOC, '');
  const open = s.indexOf('<<');
  return open === -1 ? s : s.slice(0, open);
}

// The length of the shell separator at s[i], outside quotes, or 0: &&, ||, ;, |,
// a newline, a parenthesis, or a lone & (but not the & in 2>&1 or &>).
function separatorAt(s, i) {
  const two = s.slice(i, i + 2);
  if (two === '&&' || two === '||') return 2;
  if (';|\n()'.includes(s[i])) return 1;
  return s[i] === '&' && s[i - 1] !== '>' && s[i + 1] !== '>' ? 1 : 0;
}

// One character inside quotes: the closing quote ends the quote, and in double
// quotes a backslash escapes ", \, $ and the backtick. Returns how many characters
// it used.
function quotedStep(st, s, i) {
  if (s[i] === st.quote) {
    st.quote = null;
    return 1;
  }
  const escaped = st.quote === '"' && s[i] === '\\' && '"\\$`'.includes(s[i + 1]);
  st.word += escaped ? s[i + 1] : s[i];
  return escaped ? 2 : 1;
}

function endWord(st) {
  if (st.word !== null) st.segments.at(-1).push(st.word);
  st.word = null;
}

// One character outside quotes: a separator ends the command, a space ends the
// word, a backslash takes the next character as it is (a backslash and newline
// join two lines), and a quote opens. Returns how many characters it used.
function plainStep(st, s, i) {
  const sep = separatorAt(s, i);
  if (sep || /\s/.test(s[i])) {
    endWord(st);
    if (s[i] === '(') st.parens.push(s[i - 1] === '$');
    const closesSubst = s[i] === ')' && st.parens.pop() === true;
    if (sep) st.segments.push(closesSubst ? [AFTER_SUBST] : []);
    return Math.max(sep, 1);
  }
  if (s[i] === '\\') {
    if (s[i + 1] !== '\n') st.word = (st.word ?? '') + (s[i + 1] ?? '');
    return 2;
  }
  if (s[i] === "'" || s[i] === '"') st.quote = s[i];
  st.word = (st.word ?? '') + (st.quote ? '' : s[i]);
  return 1;
}

// The commands of a shell line, each as its list of words, with quotes removed and
// heredoc bodies dropped.
// The words after a $(...) closes belong to the command the substitution sits in,
// whose name is in an earlier segment. Their segment starts with this marker, and
// bashReadPaths skips it.
const AFTER_SUBST = Symbol('after $(...)');

function shellSegments(command) {
  const s = stripHeredocs(command);
  const st = { segments: [[]], word: null, quote: null, parens: [] };
  for (let i = 0; i < s.length; ) i += st.quote ? quotedStep(st, s, i) : plainStep(st, s, i);
  endWord(st);
  return st.segments.filter((w) => w.length);
}

// Words that take the next word as their value, per wrapper.
const WRAPPER_VALUE_OPTS = { env: new Set(['-u', '-C', '-S', '--unset', '--chdir']), nice: new Set(['-n', '--adjustment']), timeout: new Set(['-s', '-k', '--signal', '--kill-after']), xargs: new Set(['-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter']) };
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
// Shell words that can stand before a command in one segment: the command after
// them is the one that runs.
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{']);

// One wrapper word and its own options at words[0], dropped. Returns the rest, or
// null when words[0] is not a wrapper.
function unwrap(words) {
  const name = path.basename(words[0]);
  if (name === 'rtk') return ['bypass', 'proxy'].includes(words[1]) ? words.slice(2) : words[1] === 'read' ? ['cat', ...words.slice(2)] : words.slice(1);
  if (SHELL_KEYWORDS.has(words[0])) return words.slice(1);
  if (!['sudo', 'env', 'nohup', 'nice', 'time', 'command', 'exec', 'timeout', 'xargs'].includes(name)) return null;
  const valueOpts = WRAPPER_VALUE_OPTS[name] ?? new Set();
  let i = 1;
  while (i < words.length && (words[i].startsWith('-') || (name === 'env' && ASSIGNMENT.test(words[i])))) i += valueOpts.has(words[i]) ? 2 : 1;
  if (name === 'timeout') i++; // the duration
  return words.slice(i);
}

// The command's words without leading NAME=value assignments and wrapper commands.
function stripWrappers(words) {
  let w = words;
  for (;;) {
    while (w.length && ASSIGNMENT.test(w[0])) w = w.slice(1);
    const rest = w.length ? unwrap(w) : null;
    if (rest === null) return w;
    w = rest;
  }
}

// An in-place edit: sed with -i anywhere among its options, or perl with a short
// flag group holding i (-i, -pi, -i.bak).
function editsInPlace(cmd, args) {
  const flags = args.filter((a) => /^-[^-]/.test(a));
  if (cmd === 'sed') return flags.some((a) => /^-i/.test(a) || /^-[a-zA-Z]*i/.test(a)) || args.includes('--in-place');
  return cmd === 'perl' && flags.some((a) => /^-[a-zA-Z]*i/.test(a));
}

// The words of a command that could name a file, in order: no options, no output
// redirections with their targets, no words with a $, *, ? or backtick. An input
// redirection offers its target. A `--name=value` option offers nothing, because
// its value is more often an output file than an input.
function candidates(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (REDIRECT.test(a)) {
      if (a === '<') {
        if (i + 1 < args.length) out.push(args[i + 1]);
        i++;
      } else if (!/^\d*>&\d+$/.test(a)) i++;
    } else if (/^(\d*|&)>/.test(a)) continue;
    else if (a.startsWith('<')) out.push(a.slice(1));
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

// A candidate as an absolute path: a leading ~/ is the home folder, a relative path
// joins the shell folder, and a path with a ~ elsewhere, or a relative one with no
// known folder, is null.
function absolute(word, dir) {
  if (NOT_A_PATH.test(word) || word === '') return null;
  if (word.startsWith('~/')) return path.join(os.homedir(), word.slice(2));
  if (word.includes('~')) return null;
  if (path.isAbsolute(word)) return word;
  return dir === null ? null : path.join(dir, word);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// The files one command reads: every word that names an existing file.
function readArgs(words, dir) {
  const [cmd, ...args] = stripWrappers(words);
  if (cmd === undefined) return [];
  const name = path.basename(cmd);
  if (NON_READERS.has(name) || editsInPlace(name, args)) return [];
  return candidates(args).map((w) => absolute(w, dir)).filter((p) => p !== null && isFile(p));
}

// The shell's folder after `cd <d>`, or null when it cannot be known.
function cdTarget(dir, d) {
  if (!d || d === '-' || d.includes('~') || NOT_A_PATH.test(d)) return null;
  if (path.isAbsolute(d)) return d;
  return dir === null ? null : path.join(dir, d);
}

// The files a Bash command reads, in order. Any word of a command (after wrappers
// such as sudo, env, timeout, rtk) that names a file that exists counts, unless the
// command is in NON_READERS or edits in place. cwd is the shell's folder when the
// command starts, if known. A relative path is joined to the folder the shell is in
// at that point, and dropped when that is unknown. The check runs when the
// transcript is read, so a file deleted since the command ran is not listed.
function bashReadPaths(command, cwd = null) {
  const out = [];
  let dir = cwd;
  for (const words of shellSegments(command)) {
    if (words[0] === AFTER_SUBST) continue;
    if (words[0] === 'cd') dir = cdTarget(dir, words[1]);
    else out.push(...readArgs(words, dir));
  }
  return out;
}

// Every file a transcript's steps read, with the Read tool or through Bash, once
// each, in the order first read. A Bash read starts from its record's cwd.
function filesRead(lines) {
  const parsed = parseAll(lines);
  const files = new Set();
  for (const s of stepsOf(lines, 1, lines.length)) {
    if (s.kind !== 'tool') continue;
    if (s.tool === 'Read' && s.text) files.add(s.text);
    const cwd = parsed[s.line - 1]?.cwd;
    if (s.tool === 'Bash') for (const file of bashReadPaths(s.text, typeof cwd === 'string' ? cwd : null)) files.add(file);
  }
  return [...files];
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
// relative to the worktree, so a path ending in /<file> matches too. An entry
// ending in / is a folder and covers every file under it.
function isTaskFile(file, files) {
  return files.some((f) => {
    if (f.endsWith('/')) return file.startsWith(f) || file.includes('/' + f);
    return file === f || file.endsWith('/' + f);
  });
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
// sets seen.report, and watchEvents reports it last, as DONE. A coordinator
// message after it resumes the worker and clears it, so a resumed worker is
// followed to its last report. seen.lastKind is the kind of the last step, which
// watchEvents reads to tell a killed worker (interrupt) or a failed one
// (apierror) from one still running; a coordinator message replaces it.
function stepEvents(steps, seen, files) {
  const events = [];
  for (const s of steps) {
    seen.lastKind = s.kind;
    if (s.kind === 'msg') seen.report = null;
    const event = s.kind === 'error' ? stuckEvent(s, seen) : driftEvent(s, seen, files);
    if (event) events.push(event);
    if (s.kind === 'msg') events.push(`MSG landed at line ${s.line}`);
    if (s.kind === 'text') seen.lastText = s.text;
    if (s.kind === 'text' || (s.kind === 'tool' && s.tool !== 'SubagentHandback')) seen.lastAction = s.kind === 'text' ? s.text : `${s.tool} ${s.text}`;
    if (s.kind === 'apierror') seen.lastError = s.text;
    if (s.tool === 'SubagentHandback') seen.report = s.text;
  }
  return events;
}

// The new events in a worker transcript since the last poll, for --watch. Pure:
// seen is what earlier polls saw (null on the first), returned updated. Each event
// is reported once per occurrence, so a watch that polls every two seconds does
// not repeat itself. opts.finished is the meta file's finished flag; it ends the
// watch when the worker stopped without a SubagentHandback, unless a coordinator
// message is the last step (the flag can be left from before a resume). Claude
// Code sets the flag before the worker's last lines reach the transcript, so the
// flag ends the watch only once it has held for a poll with no new lines.
// opts.steps are the steps of seen.next..lines.length when the caller already has them,
// so the lines are not parsed again. opts.sinceLine starts a new watch after that line,
// so a watch re-armed after the Monitor tool's time limit does not repeat what the last
// one reported.
//
// Two more events end the watch. KILLED <last action> is reported when the last line
// is Claude Code's interrupt marker (the worker was stopped) and it has held for a poll
// with no new lines. FAILED <error> is reported when the last line is an API error
// record that has held for opts.holdMs (default 30 s) of opts.now (default Date.now()),
// because Claude Code can retry an API error. A coordinator message after either is the
// last step instead, so a resumed worker is followed on: they clear the end, so a later report gives DONE and a second kill gives a second KILLED. After KILLED or FAILED, polls on an unchanged transcript return done with no events. MSG events are returned here
// for the dashboard; bin/transcript-index does not print them.
function watchEvents(lines, seen, opts) {
  const start = { next: (opts.sinceLine ?? 0) + 1, drifted: new Set(), failures: null, overBudget: false, lastText: '', lastKind: null, report: null, finishedAt: null, interruptAt: null, errorHold: null, ended: null, lastAction: '', lastError: '', done: false };
  const prev = seen ?? start;
  const state = { ...prev, drifted: new Set(prev.drifted) };
  if (state.done) return { events: [], seen: state, done: true };
  // KILLED and FAILED end one watch but not the worker: lines after them are a resume.
  if (state.ended?.lines === lines.length) return { events: [], seen: state, done: true };
  state.ended = null;
  const events = lines.length >= state.next ? stepEvents(opts.steps ?? stepsOf(lines, state.next, lines.length), state, opts.files) : [];
  state.next = Math.max(state.next, lines.length + 1);
  if (opts.budget != null && !state.overBudget) {
    const tokens = contextTokens(lines);
    if (tokens !== null && tokens > opts.budget) {
      state.overBudget = true;
      events.push(`BUDGET context ${tokens} tokens, over ${opts.budget}`);
    }
  }
  const settled = opts.finished && state.finishedAt === lines.length;
  state.finishedAt = opts.finished ? lines.length : null;
  const killed = state.lastKind === 'interrupt' && state.interruptAt === lines.length;
  state.interruptAt = state.lastKind === 'interrupt' ? lines.length : null;
  const now = opts.now ?? Date.now();
  state.errorHold = state.lastKind === 'apierror' ? (state.errorHold?.lines === lines.length ? state.errorHold : { lines: lines.length, at: now }) : null;
  const failed = state.errorHold !== null && now - state.errorHold.at >= (opts.holdMs ?? 30_000);
  if (state.report !== null) {
    state.done = true;
    events.push(`DONE ${flat(state.report).slice(0, 160)}`.trimEnd());
  } else if (killed) {
    state.ended = { kind: 'KILLED', lines: lines.length };
    events.push(`KILLED ${flat(state.lastAction).slice(0, 160)}`.trimEnd());
  } else if (failed) {
    state.ended = { kind: 'FAILED', lines: lines.length };
    events.push(`FAILED ${flat(state.lastError).slice(0, 160)}`.trimEnd());
  } else if (settled && state.lastKind !== 'msg') {
    state.done = true;
    events.push(`DONE ${flat(state.lastText).slice(0, 160)}`.trimEnd());
  }
  return { events, seen: state, done: state.done || state.ended !== null };
}

// The board's new posts as `POST <from>: <title>` events, for --watch --board.
// text is the whole board file (bin/board-post writes one JSON line per post);
// seenLines is how many complete lines earlier reads covered. A last line with no
// newline is still being written and is left for the next read. A line that is not
// a post is skipped.
function boardEvents(text, seenLines) {
  const lines = text.split('\n');
  lines.pop();
  const events = [];
  for (const line of lines.slice(seenLines)) {
    const p = parseAll([line])[0];
    if (typeof p?.from === 'string' && typeof p.title === 'string') events.push(`POST ${flat(p.from)}: ${flat(p.title)}`);
  }
  return { events, seenLines: Math.max(seenLines, lines.length) };
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
  facts.resumedFrom = resumed ? (resumed[1] === undefined ? resumed[2] : resumed[1].replace(/'\\''/g, "'")) : null;

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

module.exports = { buildIndex, isTaskFile, stepsOf, recentSteps, contextTokens, watchEvents, boardEvents, bashReadPaths, filesRead, renderIndex, agentTranscriptPath };
