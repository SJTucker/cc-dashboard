'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { forEachLine } = require('./extract');

// The rules Claude already had in a reviewed session: the CLAUDE.md files Claude
// Code loads for it and the project's memory index. bin/review-session puts them
// ahead of the digest, so Haiku does not suggest a rule the user already has. The
// files are read as they are at review time, so each one edited after the session
// started is marked, and Haiku does not count a rule added later as broken.

const RULES_HEADER = 'RULES THE USER ALREADY HAS';
const DIGEST_HEADER = 'SESSION DIGEST';
const RULES_CHARS = 30_000;
const CHANGED_NOTE = 'changed after the session started';
// Claude Code follows @path includes this many levels deep.
const MAX_INCLUDE_DEPTH = 5;

const expandHome = (p, home) => p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);

// Files a CLAUDE.md pulls in with a line of its own, `@path`. A relative path is
// relative to the CLAUDE.md's folder (`base`). Same rule as includedPaths in
// mod/hooks/setup.ts.
function includedPaths(text, base, home) {
  const paths = [];
  for (const line of text.split('\n')) {
    const match = /^@(\S+)\s*$/.exec(line.trim());
    if (!match) continue;
    const raw = expandHome(match[1], home);
    const full = raw.startsWith('/') ? raw : path.join(base, raw);
    if (!paths.includes(full)) paths.push(full);
  }
  return paths;
}

// Null for a missing file, a folder or an unreadable file.
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function changedSince(file, startedAt) {
  if (startedAt === null) return false;
  try {
    return fs.statSync(file).mtimeMs > startedAt;
  } catch {
    return false;
  }
}

function addFile(out, seen, file, startedAt) {
  if (seen.has(file)) return null;
  seen.add(file);
  const text = readText(file);
  if (text === null || !text.trim()) return null;
  out.push({ file, text, changed: changedSince(file, startedAt) });
  return text;
}

// A file, then the files it includes, depth first.
function addWithIncludes(out, seen, file, home, startedAt, depth = 0) {
  if (depth > MAX_INCLUDE_DEPTH) return;
  const text = addFile(out, seen, file, startedAt);
  if (text === null) return;
  for (const included of includedPaths(text, path.dirname(file), home)) addWithIncludes(out, seen, included, home, startedAt, depth + 1);
}

// CLAUDE.md and CLAUDE.local.md in the launch folder and each folder above it,
// outermost first, the order Claude Code loads them.
function projectFiles(cwd) {
  const dirs = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  return dirs.flatMap((dir) => [path.join(dir, 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md')]);
}

// Each file is listed once, in the order Claude Code loads it. The memory index
// goes last and is read as it is, without includes. `changed` is true for a file
// modified after `startedAt`.
function ruleFiles({ configDir = null, cwd = null, memoryIndex = null, startedAt = null, home = os.homedir() }) {
  const out = [];
  const seen = new Set();
  if (configDir) addWithIncludes(out, seen, path.join(configDir, 'CLAUDE.md'), home, startedAt);
  if (cwd) for (const file of projectFiles(cwd)) addWithIncludes(out, seen, file, home, startedAt);
  if (memoryIndex) addFile(out, seen, memoryIndex, startedAt);
  return out;
}

// The main checkout of the git repo that holds `cwd`. A worktree's .git is a file
// naming its folder under the main .git, and that folder's commondir file points
// back to the main .git. Null outside a repo or when the folder is gone.
function repoRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {}
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '')?.[1]?.trim();
      if (!gitdir) return null;
      const common = readText(path.join(path.resolve(dir, gitdir), 'commondir'));
      return common === null ? dir : path.dirname(path.resolve(dir, gitdir, common.trim()));
    }
    if (path.dirname(dir) === dir) return null;
  }
}

// Claude Code keeps one memory folder per repo, under the main checkout's project
// folder, so a worktree or subfolder session shares it. Outside a repo, or when
// that folder has no index, the index is the one next to the transcript.
function memoryIndexPath({ projects, cwd, transcript }) {
  const beside = path.join(path.dirname(transcript), 'memory', 'MEMORY.md');
  const root = cwd ? repoRoot(cwd) : null;
  if (!root) return beside;
  const shared = path.join(projects, root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
  return fs.existsSync(shared) ? shared : beside;
}

function rulesText(files, limit = RULES_CHARS) {
  const text = files.map(({ file, text, changed }) => `=== ${file}${changed ? ` (${CHANGED_NOTE})` : ''} ===\n${text.trim()}`).join('\n\n');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} characters cut ...]`;
}

// With no rules, the prompt is the digest alone, as it was before rules were sent.
function reviewPrompt(rules, digest) {
  return rules ? `${RULES_HEADER}\n${rules}\n\n${DIGEST_HEADER}\n${digest}` : digest;
}

// The folder the session started in, which decides the project CLAUDE.md files,
// and when it started. Each is taken from the first line that has it. A later line
// can show another folder after a cd. Both are null when no line has them or the
// file cannot be read.
async function readSessionStart(file) {
  const start = { cwd: null, startedAt: null };
  try {
    await forEachLine(file, (line) => {
      if (start.cwd && start.startedAt !== null) return;
      if (!line.includes('"cwd"') && !line.includes('"timestamp"')) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!start.cwd && typeof parsed?.cwd === 'string' && parsed.cwd) start.cwd = parsed.cwd;
      const at = typeof parsed?.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
      if (start.startedAt === null && Number.isFinite(at)) start.startedAt = at;
    });
  } catch {
    return { cwd: null, startedAt: null };
  }
  return start;
}

module.exports = { RULES_HEADER, DIGEST_HEADER, RULES_CHARS, CHANGED_NOTE, includedPaths, ruleFiles, memoryIndexPath, rulesText, reviewPrompt, readSessionStart };
