'use strict';

const fs = require('fs');
const path = require('path');
const { validRunDir, TASK_FILE } = require('./claims');

// The event log of one orchestrate run, <run>/events.jsonl. Each line is one JSON
// object, written with a single append so writers running at once do not interleave.

const ORCHESTRATOR_KINDS = Object.freeze(['ready', 'waiting', 'answered', 'steer', 'review-pass', 'review-fail', 'merged', 'dropped']);
// added and released come from claims.js, claimed and watch from bin/transcript-index --watch, denied from the mod.
const EVENT_KINDS = Object.freeze(['added', 'released', 'claimed', 'watch', 'denied', ...ORCHESTRATOR_KINDS]);
const TEXT_MAX = 500;

function eventsPath(runDir) {
  return path.join(runDir, 'events.jsonl');
}

// Appends one event, stamped with `t`, and returns it. Returns null without writing
// for an invalid run folder or kind. A failed append also returns null, so a full
// disk or a missing run folder never breaks the caller. Creates no folder.
function appendEvent(runDir, event, now = new Date()) {
  if (!validRunDir(runDir) || !EVENT_KINDS.includes(event?.kind)) return null;
  const line = { t: now.toISOString(), ...event };
  if (typeof line.text === 'string') line.text = line.text.slice(0, TEXT_MAX);
  try {
    if (!fs.statSync(runDir).isDirectory()) return null;
    fs.appendFileSync(eventsPath(runDir), JSON.stringify(line) + '\n');
  } catch {
    return null;
  }
  return line;
}

// The events in a log's text, oldest first. Lines that are not JSON objects with a
// string `t` and a known `kind` are skipped, such as a line cut off mid-write.
function parseEvents(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (e && typeof e === 'object' && typeof e.t === 'string' && EVENT_KINDS.includes(e.kind)) out.push(e);
  }
  return out;
}

// The task number and attempt of a task file name, <seq>-t<N>-a<A>.json, or null.
function taskOfFile(file) {
  if (typeof file !== 'string' || !TASK_FILE.test(file)) return null;
  const m = /-t(\d+)-a(\d+)\.json$/.exec(file);
  return { task: Number(m[1]), attempt: Number(m[2]) };
}

module.exports = { EVENT_KINDS, ORCHESTRATOR_KINDS, eventsPath, appendEvent, parseEvents, taskOfFile };
