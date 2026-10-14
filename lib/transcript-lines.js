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

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ');
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

// A main-thread user line with prompt-shaped content and neither origin nor
// promptSource. A prompt line is tagged when it carries either one: typed prompts
// carry both, and `claude -p` lines carry promptSource 'sdk' and no origin.
// Compact summaries are not prompts. A file with untagged lines and no typed
// prompt suggests a Claude Code version that tags prompts another way, which
// isTypedPrompt would miss.
function isUntaggedPrompt(parsed) {
  if (parsed.type !== 'user' || parsed.isMeta || parsed.isSidechain === true) return false;
  if (Object.hasOwn(parsed, 'origin') || Object.hasOwn(parsed, 'promptSource') || parsed.isCompactSummary) return false;
  const content = parsed.message?.content;
  return typeof content === 'string' && !content.trimStart().startsWith('<command');
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

module.exports = { forEachLine, isTypedPrompt, isUntaggedPrompt, promptPreview, toolDetail, resultText };
