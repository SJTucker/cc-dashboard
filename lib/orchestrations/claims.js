'use strict';

const fs = require('fs');
const path = require('path');
const { resultText } = require('../transcript-lines');

// The claim queue of one orchestration run. The run folder is <image>.run/ with
// pending/work/, pending/review/ and claimed/. The orchestrator adds a task file
// before dispatching each agent; the agent claims the oldest one with
// bin/orch-claim after reading the shared first message.

const TASK_FILE = /^\d{4}-t\d+-a\d+\.json$/;
const KINDS = ['work', 'review'];
const CLAIM_COMMAND = /\borch-claim\s+['"]?\S+?['"]?\s+(?:work|review)\b/;

function runDirOf(imagePath) {
  return imagePath.replace(/\.md$/, '.run');
}

function validRunDir(dir) {
  return typeof dir === 'string' && path.isAbsolute(dir) && dir.endsWith('.run') && path.normalize(dir) === dir;
}

function pendingDir(runDir, kind) {
  return path.join(runDir, 'pending', kind);
}

function claimedDir(runDir) {
  return path.join(runDir, 'claimed');
}

function taskNames(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => TASK_FILE.test(n)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Writes a file under a dot name, then renames it into place, so a reader never sees half a file.
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Adds a task to pending/<kind>/ and returns its file name, <seq>-t<N>-a<attempt>.json.
// <seq> is one more than the highest in either queue and claimed/. Only the
// orchestrator adds tasks, so this is not safe against concurrent callers.
function addTask(runDir, kind, task) {
  fs.mkdirSync(pendingDir(runDir, 'work'), { recursive: true });
  fs.mkdirSync(pendingDir(runDir, 'review'), { recursive: true });
  fs.mkdirSync(claimedDir(runDir), { recursive: true });
  let max = 0;
  for (const dir of [pendingDir(runDir, 'work'), pendingDir(runDir, 'review'), claimedDir(runDir)]) {
    for (const n of taskNames(dir)) max = Math.max(max, Number(n.slice(0, 4)));
  }
  const name = `${String(max + 1).padStart(4, '0')}-t${task.task}-a${task.attempt ?? 1}.json`;
  writeAtomic(path.join(pendingDir(runDir, kind), name), JSON.stringify(task, null, 2) + '\n');
  return name;
}

// Claims the lowest pending task of a kind: link into claimed/ (fails with EEXIST
// when another claimer holds it), remove the pending name, then stamp claimedAt.
// hooks.afterLink runs between the link and the removal, for tests.
function claimNext(runDir, kind, now = new Date(), hooks = {}) {
  const pend = pendingDir(runDir, kind);
  const claimed = claimedDir(runDir);
  for (const name of taskNames(pend)) {
    fs.mkdirSync(claimed, { recursive: true });
    const from = path.join(pend, name);
    const to = path.join(claimed, name);
    try {
      fs.linkSync(from, to);
    } catch (err) {
      if (err.code === 'EEXIST') fs.rmSync(from, { force: true });
      else if (err.code !== 'ENOENT') throw err;
      continue;
    }
    hooks.afterLink?.(from);
    fs.rmSync(from, { force: true });
    const task = { ...JSON.parse(fs.readFileSync(to, 'utf8')), claimedAt: now.toISOString() };
    writeAtomic(to, JSON.stringify(task, null, 2) + '\n');
    return { file: name, task };
  }
  return null;
}

// Returns a claimed task to its pending queue with one rename. claimedAt is
// removed first, in place, so the rename moves the finished file.
function release(runDir, file) {
  const task = readClaimed(runDir, file);
  if (!task) throw new Error(`no claimed task ${file}`);
  const to = path.join(claimedDir(runDir), file);
  delete task.claimedAt;
  writeAtomic(to, JSON.stringify(task, null, 2) + '\n');
  fs.renameSync(to, path.join(pendingDir(runDir, task.kind === 'review' ? 'review' : 'work'), file));
}

// The task a claimed file holds, or null for an invalid run folder or name, a
// missing or unparseable file, or a `files` that is not an array of strings.
function readClaimed(runDir, file) {
  if (!validRunDir(runDir) || typeof file !== 'string' || !TASK_FILE.test(file)) return null;
  let task;
  try {
    task = JSON.parse(fs.readFileSync(path.join(claimedDir(runDir), file), 'utf8'));
  } catch {
    return null;
  }
  if (!task || typeof task !== 'object' || !Array.isArray(task.files) || !task.files.every((f) => typeof f === 'string')) return null;
  return task;
}

function status(runDir) {
  const unstamped = taskNames(claimedDir(runDir)).filter((n) => {
    try {
      return !JSON.parse(fs.readFileSync(path.join(claimedDir(runDir), n), 'utf8')).claimedAt;
    } catch {
      return true;
    }
  });
  return { work: taskNames(pendingDir(runDir, 'work')), review: taskNames(pendingDir(runDir, 'review')), unstamped };
}

// The instructions orch-claim prints for a claimed task.
function formatClaim(file, task) {
  const isReview = task.kind === 'review';
  const lines = [
    `CLAIMED ${file}`,
    `Your worktree is ${task.worktree}; run every command there and touch no other checkout.`,
    `${isReview ? 'Review ' : ''}Task ${task.task} of ${task.plan}, "${task.title}".`,
    `Files this task touches: ${task.files.join(', ')}.`,
    `Done when: ${task.doneWhen}.`,
  ];
  if (Array.isArray(task.sections) && task.sections.length > 0) lines.push(`Image sections that matter most: ${task.sections.join(', ')}.`);
  if (task.branch) lines.push(`Branch: ${task.branch}.`);
  if (isReview && task.implementer) lines.push(`Implementer transcript: ${task.implementer.transcript}`);
  if (task.attempt > 1) lines.push(`Attempt ${task.attempt}.`);
  if (task.notes) lines.push(`Notes: ${task.notes}`);
  return lines.join('\n');
}

// Each orch-claim result in a worker transcript that starts with CLAIMED, in
// transcript order. `line` is the 1-based line of the tool result.
function claimsInTranscript(lines) {
  const ids = new Set();
  const found = [];
  lines.forEach((text, i) => {
    if (!text.includes('orch-claim') && !text.includes('CLAIMED ')) return;
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return;
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && CLAIM_COMMAND.test(b.input.command)) {
        ids.add(b.id);
      } else if (b.type === 'tool_result' && ids.has(b.tool_use_id) && !b.is_error) {
        const m = /^CLAIMED (\S+)/.exec(resultText(b.content));
        if (m) found.push({ file: m[1], line: i + 1 });
      }
    }
  });
  return found;
}

module.exports = { TASK_FILE, KINDS, runDirOf, validRunDir, addTask, claimNext, release, readClaimed, status, formatClaim, claimsInTranscript };
