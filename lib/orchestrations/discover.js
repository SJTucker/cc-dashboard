'use strict';

const fs = require('fs');
const path = require('path');
const { readSessions, getSessionsDir, LIVE_WINDOW_MS, END_GRACE_MS } = require('../sessions');
const { readActivity, getActivityDir, resolveActivity } = require('../activity');
const { agentTranscriptPath, stepsOf } = require('../transcript-index');
const { createLinesCache } = require('./lines-cache');
const { parseBoard } = require('./board');
const { parseOrchestrator, RESET_LINE, promptOf } = require('./parse');
const { workerState, resolveStatuses, groupWaves } = require('./workers');
const { actionFeed, nowLine } = require('./feed');

// How each worker status counts on a card (the Summary.counts decision).
// A transcript lookup that found nothing is not repeated before this.
const MISS_RETRY_MS = 60 * 1000;

const COUNTED_AS = {
  working: 'working', quiet: 'working', starting: 'working',
  done: 'review', review: 'review', passed: 'review', changes: 'review',
  merged: 'merged',
  stuck: 'attention',
};

// The image's file name without its YYYY-MM-DD- prefix and .md, or null.
function topicOf(imagePath) {
  if (!imagePath) return null;
  const name = path.basename(imagePath).replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return name || null;
}

// Finds today's orchestrator sessions and builds the Orchestration tab's two views
// from them: list() for the switcher and detail(id) for one orchestration. It keeps
// one lines cache, the watchEvents state of each worker between polls, and the
// transcript path of each session id it has found.
function createOrchestrations(configDir, { now = Date.now } = {}) {
  const lines = createLinesCache({ now });
  const seenByWorker = new Map(); // `${sessionId}:${agentId}` -> workerState's seen
  const transcripts = new Map(); // sessionId -> transcript path
  const parsedByFile = new Map(); // transcript path -> { lines, parsed }
  const scans = new Map(); // sessionId -> { offset, tail, promptChecked, detected }
  const misses = new Map(); // sessionId -> when its transcript was last looked for in vain

  const skillFile = path.join(configDir, 'skills', 'orchestrate', 'SKILL.md');
  const projectsDir = path.join(configDir, 'projects');

  function installed() {
    try {
      fs.accessSync(skillFile, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // One listing of <cfg>/projects/*/ fills the path of every wanted session id. An id
  // with no transcript, such as a headless session, is looked for again after 60 s.
  function findTranscripts(ids, t) {
    const missing = ids.filter((id) => !transcripts.has(id) && !(t - (misses.get(id) ?? -Infinity) < MISS_RETRY_MS));
    if (!missing.length) return;
    const wanted = new Set(missing);
    let dirs = [];
    try {
      dirs = fs.readdirSync(projectsDir);
    } catch {
      // No projects folder yet.
    }
    for (const dir of dirs) {
      let names;
      try {
        names = fs.readdirSync(path.join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.replace(/\.jsonl$/, '');
        if (name.endsWith('.jsonl') && wanted.has(id)) transcripts.set(id, path.join(projectsDir, dir, name));
      }
    }
    for (const id of missing) {
      if (transcripts.has(id)) misses.delete(id);
      else misses.set(id, t);
    }
  }

  // Whether a session shows the orchestrate markers: a Skill call with skill
  // "orchestrate", or a first user prompt that is the reset line. Only the bytes
  // appended since the last call are read, and no lines are kept, so a session that
  // is not an orchestrator costs its byte offset. A session can call the skill
  // partway through, so a negative answer is rechecked on each poll.
  function isDetected(sessionId, file) {
    let st = scans.get(sessionId);
    if (st?.detected) return true;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return false;
    }
    if (!st || size < st.offset) {
      st = { offset: 0, tail: Buffer.alloc(0), promptChecked: false, detected: false };
      scans.set(sessionId, st);
    }
    if (size === st.offset) return false;
    const buf = Buffer.alloc(size - st.offset);
    let n = 0;
    const fd = fs.openSync(file, 'r');
    try {
      n = fs.readSync(fd, buf, 0, buf.length, st.offset);
    } finally {
      fs.closeSync(fd);
    }
    st.offset += n;
    const data = Buffer.concat([st.tail, buf.subarray(0, n)]);
    const end = data.lastIndexOf(0x0a);
    if (end === -1) {
      st.tail = data;
      return false;
    }
    st.tail = Buffer.from(data.subarray(end + 1));
    for (const raw of data.subarray(0, end).toString('utf8').split('\n')) {
      if (st.promptChecked && !raw.includes('orchestrate')) continue;
      let r;
      try {
        r = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!st.promptChecked) {
        const p = promptOf(r);
        if (p !== null) {
          st.promptChecked = true;
          if (RESET_LINE.test(p)) st.detected = true;
        }
      }
      const blocks = Array.isArray(r?.message?.content) ? r.message.content : [];
      if (r?.type === 'assistant' && blocks.some((b) => b.type === 'tool_use' && b.name === 'Skill' && b.input?.skill === 'orchestrate')) st.detected = true;
    }
    return st.detected;
  }

  // parseOrchestrator over the whole transcript is repeated only when it grew.
  function parsedOf(file, read) {
    const hit = parsedByFile.get(file);
    if (hit && hit.lines === read.lines) return hit.parsed;
    const parsed = parseOrchestrator(read.lines);
    parsedByFile.set(file, { lines: read.lines, parsed });
    return parsed;
  }

  function resetQueued(sessionId) {
    try {
      return fs.readFileSync(path.join(configDir, 'cc-dashboard', 'reset-prompt', `${sessionId}.txt`), 'utf8').trim() !== '';
    } catch {
      return false;
    }
  }

  // Drops what the maps hold for sessions that left the snapshot window, so a server
  // that runs for days does not keep every transcript it has seen.
  function sweep(snapshotIds, members) {
    const memberIds = new Set(members.map((m) => m.snap.sessionId));
    const memberFiles = new Set(members.map((m) => m.file));
    for (const map of [transcripts, scans, misses]) for (const id of map.keys()) if (!snapshotIds.has(id)) map.delete(id);
    for (const file of parsedByFile.keys()) if (!memberFiles.has(file)) parsedByFile.delete(file);
    for (const key of seenByWorker.keys()) if (!memberIds.has(key.slice(0, key.indexOf(':')))) seenByWorker.delete(key);
  }

  // Today's orchestrator sessions, grouped: sessions with the same image, or joined
  // by a clearedFrom link, are one orchestration. Oldest session first in each group.
  function groups(t) {
    const snapshots = readSessions(getSessionsDir(configDir), t);
    findTranscripts(snapshots.map((s) => s.sessionId), t);
    const members = [];
    for (const snap of snapshots) {
      const file = transcripts.get(snap.sessionId);
      if (!file || !isDetected(snap.sessionId, file)) continue;
      const read = lines.read(file);
      if (!read) continue;
      const parsed = parsedOf(file, read);
      if (parsed.isOrchestrator) members.push({ snap, file, read, parsed });
    }
    sweep(new Set(snapshots.map((x) => x.sessionId)), members);
    const byId = new Map(members.map((m) => [m.snap.sessionId, m]));
    const root = new Map(members.map((m) => [m.snap.sessionId, m.snap.sessionId]));
    const find = (id) => (root.get(id) === id ? id : find(root.get(id)));
    const join = (a, b) => root.set(find(a), find(b));
    const byImage = new Map();
    for (const m of members) {
      const id = m.snap.sessionId;
      if (m.parsed.imagePath) {
        if (byImage.has(m.parsed.imagePath)) join(id, byImage.get(m.parsed.imagePath));
        else byImage.set(m.parsed.imagePath, id);
      }
      if (m.snap.clearedFrom && byId.has(m.snap.clearedFrom)) join(id, m.snap.clearedFrom);
    }
    const out = new Map();
    for (const m of members) {
      const key = find(m.snap.sessionId);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(m);
    }
    return [...out.values()].map((g) => g.sort((a, b) => a.snap.lastActiveAt - b.snap.lastActiveAt));
  }

  function workerRead(file) {
    const read = lines.read(file);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch {
      // No meta file yet, or one caught mid-write.
    }
    return { read, meta };
  }

  // Everything list() and detail() show for one group.
  function view(group, activityMap, t) {
    const first = group[0];
    const newest = group.at(-1);
    const id = first.snap.sessionId;

    const workers = [];
    const reviewers = [];
    let lastActive = newest.snap.lastActiveAt;
    for (const m of group) {
      lastActive = Math.max(lastActive, m.read.mtimeMs);
      for (const agent of m.parsed.agents) {
        if (agent.role !== 'worker' && agent.role !== 'reviewer') continue;
        const file = agentTranscriptPath(m.file, m.snap.sessionId, agent.agentId);
        const { read, meta } = workerRead(file);
        if (read) lastActive = Math.max(lastActive, read.mtimeMs);
        const key = `${m.snap.sessionId}:${agent.agentId}`;
        const r = workerState(agent, read, meta, seenByWorker.get(key), { now: t });
        seenByWorker.set(key, r.seen);
        (agent.role === 'worker' ? workers : reviewers).push(r.state);
      }
    }
    const steers = group.flatMap((m) => m.parsed.steers);
    const merges = group.flatMap((m) => m.parsed.merges);
    const statused = resolveStatuses(workers, reviewers, merges, steers);
    const waves = groupWaves(statused);

    const counts = { working: 0, review: 0, merged: 0, attention: 0 };
    for (const w of statused) if (COUNTED_AS[w.status]) counts[COUNTED_AS[w.status]]++;

    const imagePath = newest.parsed.imagePath ?? group.map((m) => m.parsed.imagePath).find(Boolean) ?? null;
    const planPath = group.map((m) => m.parsed.planPath).reverse().find(Boolean) ?? null;
    const boardPath = newest.parsed.boardPath ?? group.map((m) => m.parsed.boardPath).find(Boolean) ?? null;
    const branch = group.map((m) => m.parsed.branch).reverse().find(Boolean) ?? null;
    const boardRead = boardPath ? lines.read(boardPath) : null;
    const board = boardRead ? parseBoard(boardRead.lines) : [];

    let phase = 'plan';
    if (group.some((m) => m.parsed.finishing)) phase = 'finish';
    else if (statused.length) phase = 'waves';
    else if (imagePath || resetQueued(first.snap.sessionId)) phase = 'reset';

    const snap = newest.snap;
    const ended = typeof snap.endedAt === 'number' && snap.endedAt >= lastActive - END_GRACE_MS;
    const live = !ended && t - lastActive <= LIVE_WINDOW_MS;
    const activity = !ended ? resolveActivity(activityMap.get(snap.sessionId), t) : null;

    const summary = {
      id,
      topic: topicOf(imagePath) ?? snap.project,
      project: snap.project,
      branch,
      live,
      waiting: live && activity?.state === 'waiting',
      phase,
      wave: waves.length ? waves.at(-1).n : null,
      counts,
      lastActiveAt: lastActive,
      boardCount: board.length,
    };
    return { summary, imagePath, planPath, waves, board, newest, activity, live };
  }

  function list() {
    if (!installed()) return [];
    const t = now();
    const activityMap = readActivity(getActivityDir(configDir), t);
    const out = groups(t).map((g) => view(g, activityMap, t).summary);
    lines.prune();
    return out.sort((a, b) => Number(b.waiting) - Number(a.waiting) || Number(b.live) - Number(a.live) || b.lastActiveAt - a.lastActiveAt);
  }

  function detail(id) {
    if (!installed()) return null;
    const t = now();
    const activityMap = readActivity(getActivityDir(configDir), t);
    const group = groups(t).find((g) => g[0].snap.sessionId === id);
    if (!group) return null;
    const v = view(group, activityMap, t);
    const { parsed, read } = v.newest;
    return {
      ...v.summary,
      imagePath: v.imagePath,
      planPath: v.planPath,
      now: nowLine(parsed, stepsOf(read.lines, 1, read.lines.length), v.activity, v.live),
      waves: v.waves,
      feed: actionFeed(read.lines, parsed),
      board: v.board,
    };
  }

  // How many entries each map holds, for tests.
  function sizes() {
    return { transcripts: transcripts.size, scans: scans.size, parsed: parsedByFile.size, seen: seenByWorker.size, misses: misses.size, lines: lines.size() };
  }

  return { installed, list, detail, sizes };
}

module.exports = { createOrchestrations };
