'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { forEachLine } = require('./extract');

// The rules Claude already had in a reviewed session: the CLAUDE.md files Claude
// Code loads for it and the project's memory index. bin/review-session puts them
// ahead of the digest, so Haiku does not suggest a rule the user already has.

const RULES_HEADER = 'RULES THE USER ALREADY HAS';
const DIGEST_HEADER = 'SESSION DIGEST';
const RULES_CHARS = 30_000;
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

function addFile(out, seen, file) {
  if (seen.has(file)) return null;
  seen.add(file);
  const text = readText(file);
  if (text === null || !text.trim()) return null;
  out.push({ file, text });
  return text;
}

// A file, then the files it includes, depth first.
function addWithIncludes(out, seen, file, home, depth = 0) {
  if (depth > MAX_INCLUDE_DEPTH) return;
  const text = addFile(out, seen, file);
  if (text === null) return;
  for (const included of includedPaths(text, path.dirname(file), home)) addWithIncludes(out, seen, included, home, depth + 1);
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
// goes last and is read as it is, without includes.
function ruleFiles({ configDir = null, cwd = null, memoryIndex = null, home = os.homedir() }) {
  const out = [];
  const seen = new Set();
  if (configDir) addWithIncludes(out, seen, path.join(configDir, 'CLAUDE.md'), home);
  if (cwd) for (const file of projectFiles(cwd)) addWithIncludes(out, seen, file, home);
  if (memoryIndex) addFile(out, seen, memoryIndex);
  return out;
}

function rulesText(files, limit = RULES_CHARS) {
  const text = files.map(({ file, text }) => `=== ${file} ===\n${text.trim()}`).join('\n\n');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} characters cut ...]`;
}

// With no rules, the prompt is the digest alone, as it was before rules were sent.
function reviewPrompt(rules, digest) {
  return rules ? `${RULES_HEADER}\n${rules}\n\n${DIGEST_HEADER}\n${digest}` : digest;
}

// The folder the session started in, which decides the project CLAUDE.md files.
// It is the cwd on the first line that has one. A later line can show another
// folder after a cd. Null when no line has one or the file cannot be read.
async function readLaunchDir(file) {
  let cwd = null;
  try {
    await forEachLine(file, (line) => {
      if (cwd || !line.includes('"cwd"')) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof parsed?.cwd === 'string' && parsed.cwd) cwd = parsed.cwd;
    });
  } catch {
    return null;
  }
  return cwd;
}

module.exports = { RULES_HEADER, DIGEST_HEADER, RULES_CHARS, includedPaths, ruleFiles, rulesText, reviewPrompt, readLaunchDir };
