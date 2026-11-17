'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./files');

// Subagent transcripts, including workflow subagents at
// <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl.
const SUBAGENT_FILE = /[\\/]subagents[\\/](?:[^\\/]+[\\/])*agent-[^\\/]+\.jsonl$/;

function isSubagentFile(file) {
  return SUBAGENT_FILE.test(file);
}

// The first line of file, read in 64 KiB blocks up to the first newline because that
// line holds the whole prompt. Null when the file is empty or unreadable.
function readFirstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const block = Buffer.alloc(64 * 1024);
    const chunks = [];
    for (;;) {
      const n = fs.readSync(fd, block, 0, block.length, null);
      if (n === 0) break;
      const nl = block.subarray(0, n).indexOf(10);
      if (nl !== -1) {
        chunks.push(Buffer.from(block.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(block.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf8') || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function startedAtOf(file) {
  const line = readFirstLine(file);
  if (!line) return null;
  try {
    const ms = Date.parse(JSON.parse(line).timestamp);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

// The agent id of a subagent transcript: its file name without "agent-" and ".jsonl".
function agentIdOf(file) {
  return path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
}

const str = (v) => (typeof v === 'string' ? v : null);

// The agents row for one subagent transcript. The type, description, tool use id and
// parent come from agent-<id>.meta.json beside it. hasMeta is false when that file is
// missing or is not a JSON object. With no meta file and settled false the row will not
// be written, so agentRow returns null without reading the transcript's first line.
function agentRow(file, settled = true) {
  const parts = path.dirname(file).split(/[\\/]/);
  const subIdx = parts.indexOf('subagents');
  const agentId = agentIdOf(file);
  const meta = readJson(file.replace(/\.jsonl$/, '.meta.json'));
  const hasMeta = meta !== null && typeof meta === 'object' && !Array.isArray(meta);
  if (!hasMeta && !settled) return null;
  const m = hasMeta ? meta : {};
  return {
    agentId,
    sessionId: subIdx > 0 ? parts[subIdx - 1] : null,
    agentType: str(m.agentType),
    description: str(m.description),
    toolUseId: str(m.toolUseId),
    parentAgentId: str(m.parentAgentId),
    startedAt: startedAtOf(file),
    hasMeta,
  };
}

module.exports = { isSubagentFile, agentRow, agentIdOf };
