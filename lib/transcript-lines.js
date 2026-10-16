'use strict';

const fs = require('fs');
const readline = require('readline');

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

// The command with its leading directory changes, exports and VAR=value
// assignments removed.
function stripBashPrefixes(command) {
  let rest = command.trim();
  // Bounded rather than while(true): a hand-written command can chain a few of
  // these, and an unbounded loop on a hostile string is not worth the risk.
  for (let i = 0; i < 4; i++) {
    const match = BASH_PREFIX.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length);
  }
  return rest;
}

function bashProgram(command) {
  if (typeof command !== 'string') return null;
  const program = /^\(?\s*([\w./-]+)/.exec(stripBashPrefixes(command));
  return program ? program[1].split('/').pop() || null : null;
}

// A word or a flag such as `diff`, `-n` or `--test`. A path, a quoted string or a
// number is unique per call, so it ends the group.
const GROUP_WORD = /^-{0,2}[A-Za-z][\w-]*$/;
// git options that take a value and come before the subcommand.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c']);

// The group a Bash command counts under in the "What fills the context" table:
// the program and its first argument when that argument is a word or a flag, so
// `sed -n 1,20p a.js` and `sed -n 5,9p b.js` share the group `sed -n`. A command
// run through rtk is grouped by the command rtk ran.
function bashGroup(command) {
  const program = bashProgram(command);
  if (!program) return null;
  const words = stripBashPrefixes(command).replace(/^\(\s*/, '').split(/\s+/).slice(1);
  if (program === 'rtk') {
    const rest = words[0] === 'proxy' ? words.slice(1) : words;
    return rest.length ? bashGroup(rest.join(' ')) : 'rtk';
  }
  let i = 0;
  if (program === 'git') while (GIT_VALUE_OPTIONS.has(words[i])) i += 2;
  const next = words[i];
  return next && GROUP_WORD.test(next) ? `${program} ${next}` : program;
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

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ');
}

// The text of a prompt's message.content: the string itself, or for an array made
// only of text and image blocks (a prompt with a pasted image) its text blocks joined
// with newlines. Returns null for any other content, such as a tool_result array.
function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every((b) => b && (b.type === 'text' || b.type === 'image'))) return null;
  const texts = content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

// A prompt the user typed, as opposed to the other user-type lines: tool results
// (array content with tool_result blocks), subagent task prompts (origin null), task notifications and
// coordinator relays (their own origin.kind), meta lines, and slash-command
// wrappers, which carry origin.kind 'human' but start '<command'. A forked skill the
// user typed (/code-review ...) is the one typed prompt with no promptSource key:
// origin.kind 'human' and content starting '/'. Checked against samples from this
// machine's transcripts.
function isTypedPrompt(parsed) {
  if (parsed.type !== 'user' || parsed.isMeta) return false;
  const text = promptText(parsed.message?.content);
  if (text === null || text.trimStart().startsWith('<command')) return false;
  if (parsed.origin?.kind !== 'human') return false;
  if (parsed.promptSource === 'typed' || parsed.promptSource === 'queued') return true;
  return !Object.hasOwn(parsed, 'promptSource') && text.trimStart().startsWith('/');
}

// A prompt the user typed while Claude was still working. Claude Code writes no user
// line for it. It writes an `attachment` line whose attachment is a queued_command with
// commandMode 'prompt' and origin.kind 'human', and `prompt` is a string or an array of
// text and image blocks. The other queued_command kinds are not typed prompts:
// commandMode 'task-notification' is a background task completion, origin.kind 'peer'
// or 'coordinator' is a subagent hand-back, and attachment.isMeta marks injected text.
// Returns the prompt text for a typed one, else null. Checked against samples from this
// machine's transcripts, where no such line also appears as a typed prompt line.
function midTurnPromptText(parsed) {
  const a = parsed.attachment;
  if (parsed.type !== 'attachment' || parsed.isSidechain === true) return null;
  if (a?.type !== 'queued_command' || a.commandMode !== 'prompt' || a.origin?.kind !== 'human' || a.isMeta) return null;
  return promptText(a.prompt);
}

// A main-thread user line with prompt-shaped content and neither origin nor
// promptSource. A prompt line is tagged when it carries either one: typed prompts
// carry both, and `claude -p` lines carry promptSource 'sdk' and no origin.
// Compact summaries are not prompts. A file with untagged lines and no typed
// prompt suggests a Claude Code version that tags prompts another way, which
// isTypedPrompt would miss.
function isUntaggedPrompt(parsed) {
  if (parsed.type !== 'user' || parsed.isMeta || parsed.isSidechain === true) return false;
  if (Object.hasOwn(parsed, 'origin') || Object.hasOwn(parsed, 'promptSource') || parsed.isCompactSummary) return false;
  const text = promptText(parsed.message?.content);
  return text !== null && !text.trimStart().startsWith('<command');
}

const PROMPT_PREVIEW_CHARS = 80;

// A typed prompt as a one-line title: pasted_content tags are removed, each run of
// whitespace becomes one space, and text longer than PROMPT_PREVIEW_CHARS is cut and
// ends in an ellipsis.
function promptPreview(text) {
  const unwrapped = text.replace(/^\s*<pasted_content[^>]*>/, '').replace(/<\/pasted_content>/g, '');
  const flat = unwrapped.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_PREVIEW_CHARS ? flat.slice(0, PROMPT_PREVIEW_CHARS - 1).trimEnd() + '…' : flat;
}

// Resolves true when the file was read to the end, and false when the read
// failed. A read fails on permission denied, or when the file was deleted after
// the directory walk found it: Claude Code's cleanupPeriodDays removes old
// transcripts. Lines read before a failure have already been passed to onLine. An
// error thrown by onLine is a bug in the caller, so it still rejects.
async function forEachLine(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let readError = null;
  stream.on('error', (err) => {
    readError = err;
    rl.close();
  });
  try {
    for await (const line of rl) {
      if (line.trim()) onLine(line);
    }
  } catch (err) {
    if (readError) return false;
    throw err;
  }
  return !readError;
}

// The `.claude/handoffs/<file>.md` tail of the path in a handoff resume prompt, or
// null. The mod writes `Read <absolute path>, check Preconditions, ...` and the
// /handoff skill writes `Read .claude/handoffs/<file>.md, check ...`.
const HANDOFF_PROMPT = /^\s*Read\s+((?:\S*\/)?\.claude\/handoffs\/[^\s/,]+\.md)/;
function handoffPromptPath(text) {
  const m = HANDOFF_PROMPT.exec(text);
  if (!m) return null;
  return m[1].slice(m[1].indexOf('.claude/handoffs/'));
}

// The task in the first `# Handoff: <task>` line of a Read result, which carries
// Claude Code's line-number prefixes (`     1<tab>`). Null when there is none.
function handoffHeading(text) {
  const m = /^[ \t]*(?:\d+\t)?# Handoff: (.+)$/m.exec(text);
  return m ? m[1].trim() : null;
}

// Handoff headings from before the 6-word rule mix the task with status, so the
// title stops at the earliest of " — ", " (", "; " and ", ". The first character is
// capitalised and the length is capped like promptPreview.
function handoffTitle(heading) {
  const cuts = [' — ', ' (', '; ', ', '].map((sep) => heading.indexOf(sep)).filter((i) => i > 0);
  const task = (cuts.length ? heading.slice(0, Math.min(...cuts)) : heading).trim();
  return task ? promptPreview(task[0].toUpperCase() + task.slice(1)) : null;
}

module.exports = { handoffPromptPath, handoffHeading, handoffTitle, bashGroup, forEachLine, promptText, isTypedPrompt, midTurnPromptText, isUntaggedPrompt, promptPreview, toolDetail, resultText };
