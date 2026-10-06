'use strict';

const { forEachLine, isTypedPrompt, toolDetail, resultText } = require('./scan');

// Reviews of ended sessions, which suggest changes to the Claude Code setup. The
// mod (mod/hooks/register.ts) asks Haiku. bin/review-session runs everything here,
// so this module is the only writer of cc-dashboard/reviews/.

const PROMPT_TEXT_LIMIT = 400;
const REPLY_TEXT_LIMIT = 200;
const ERROR_TEXT_LIMIT = 200;
const LARGE_OUTPUT_CHARS = 10_000;
const DIGEST_HEAD_CHARS = 20_000;
const DIGEST_TAIL_CHARS = 40_000;

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

module.exports = { digestTranscript };
