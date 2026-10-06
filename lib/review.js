'use strict';

const { forEachLine, isTypedPrompt, toolDetail, resultText } = require('./scan');
const { stripFence } = require('./updates');

// Reviews of ended sessions, which suggest changes to the Claude Code setup. The
// mod (mod/hooks/register.ts) asks Haiku. bin/review-session runs everything here,
// so this module is the only writer of cc-dashboard/reviews/.

const PROMPT_TEXT_LIMIT = 400;
const REPLY_TEXT_LIMIT = 200;
const ERROR_TEXT_LIMIT = 200;
const LARGE_OUTPUT_CHARS = 10_000;
const DIGEST_HEAD_CHARS = 20_000;
const DIGEST_TAIL_CHARS = 40_000;

const MAX_SUGGESTIONS = 3;
const SUGGESTION_TEXT_LIMIT = 300;
const KINDS = ['claude-md', 'skill-or-hook', 'token-waste', 'workflow'];

const SYSTEM = [
  'You review one Claude Code session and suggest changes that would make later sessions go better.',
  'You get a digest of the session, one event per line:',
  'USER is a prompt the user typed. CLAUDE is the start of a reply. TOOL is a tool call with its file or program.',
  'ERROR is a failed tool call. LARGE OUTPUT is a tool result over 10,000 characters. COMPACTED marks a context compaction.',
  '',
  'Suggest only changes the digest gives direct evidence for, of these kinds:',
  '- "claude-md": a CLAUDE.md rule that would have prevented a correction the user had to make.',
  '- "skill-or-hook": a skill or hook that would have saved steps repeated in this session.',
  '- "token-waste": large tool output, the same file read again and again, or a compaction either one caused.',
  '- "workflow": a change to how the user prompted or ran the session.',
  '',
  'Most sessions need no change. When nothing has clear evidence, answer with an empty list. An empty list, {"suggestions": []}, is a good answer.',
  'Give at most 3 suggestions. Each text is one or two sentences, at most 40 words, and says what to change.',
  'Do not quote the digest. Do not repeat file contents, command output, secrets, keys or tokens.',
  '',
  'Answer with only a JSON object: {"suggestions": [{"kind": "claude-md", "text": "..."}]}',
].join('\n');

const oneLine = (text, limit) => String(text).replace(/\s+/g, ' ').trim().slice(0, limit);

// A long session keeps its first and last characters, with a marker for the cut.
function cutDigest(text) {
  if (text.length <= DIGEST_HEAD_CHARS + DIGEST_TAIL_CHARS) return text;
  const cut = text.length - DIGEST_HEAD_CHARS - DIGEST_TAIL_CHARS;
  return `${text.slice(0, DIGEST_HEAD_CHARS)}\n[... ${cut} characters cut ...]\n${text.slice(-DIGEST_TAIL_CHARS)}`;
}

// $.model.complete takes no history, so the transcript goes into the prompt. A
// whole transcript can exceed Haiku's context, so it is cut down to one line per
// typed prompt, reply start, tool call, tool error, large tool result and
// compaction. Subagent lines are left out. Null when the file cannot be read.
async function digestTranscript(file) {
  const lines = [];
  const toolNames = new Map();
  let prompts = 0;
  const ok = await forEachLine(file, (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // a line caught mid-write
    }
    if (!parsed || parsed.isSidechain || parsed.isCompactSummary) return;
    if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
      lines.push('COMPACTED');
      return;
    }
    if (isTypedPrompt(parsed)) {
      prompts++;
      lines.push(`USER: ${oneLine(parsed.message.content, PROMPT_TEXT_LIMIT)}`);
      return;
    }
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block) continue;
      if (parsed.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lines.push(`CLAUDE: ${oneLine(block.text, REPLY_TEXT_LIMIT)}`);
      } else if (parsed.type === 'assistant' && block.type === 'tool_use') {
        if (block.id && toolNames.has(block.id)) continue;
        const name = block.name || 'unknown';
        if (block.id) toolNames.set(block.id, name);
        const detail = toolDetail(name, block.input);
        lines.push(detail ? `TOOL ${name} ${detail}` : `TOOL ${name}`);
      } else if (parsed.type === 'user' && block.type === 'tool_result') {
        const name = toolNames.get(block.tool_use_id) || 'tool';
        const text = resultText(block.content);
        if (block.is_error) lines.push(`ERROR ${name}: ${oneLine(text, ERROR_TEXT_LIMIT)}`);
        else if (text.length > LARGE_OUTPUT_CHARS) lines.push(`LARGE OUTPUT ${name}: ${text.length} chars`);
      }
    }
  });
  if (!ok) return null;
  return { prompts, text: cutDigest(lines.join('\n')) };
}

// Null when the reply is not the asked-for object, so the review is recorded as
// failed. An unknown kind or an empty text drops that one suggestion.
function parseReview(text) {
  let reply;
  try {
    reply = JSON.parse(stripFence(text));
  } catch {
    return null;
  }
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.suggestions)) return null;
  const suggestions = [];
  for (const item of reply.suggestions) {
    if (!item || !KINDS.includes(item.kind) || typeof item.text !== 'string' || !item.text.trim()) continue;
    suggestions.push({ kind: item.kind, text: oneLine(item.text, SUGGESTION_TEXT_LIMIT) });
  }
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

module.exports = { KINDS, SYSTEM, digestTranscript, parseReview };
