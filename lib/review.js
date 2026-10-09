'use strict';

const fs = require('fs');
const path = require('path');
const { forEachLine, isTypedPrompt, toolDetail, resultText } = require('./extract');
const { SESSION_ID_PATTERN } = require('./session-id');
const { stripFence } = require('./updates');
const { transaction } = require('./db');
const { readJson } = require('./files');

// Reviews of ended sessions, which suggest changes to the Claude Code setup. The
// mod (mod/hooks/register.ts) asks Haiku. bin/review-session runs everything here,
// so this module and lib/review-db.js are the only writers of the reviews and
// suggestions tables in cc-dashboard/transcripts.db.

const PROMPT_TEXT_LIMIT = 400;
const REPLY_TEXT_LIMIT = 200;
const ERROR_TEXT_LIMIT = 200;
const LARGE_OUTPUT_CHARS = 10_000;
const DIGEST_HEAD_CHARS = 20_000;
const DIGEST_TAIL_CHARS = 40_000;

const MAX_SUGGESTIONS = 3;
const SUGGESTION_TEXT_LIMIT = 300;
const KINDS = ['claude-md', 'skill-or-hook', 'token-waste', 'workflow'];

const MIN_PROMPTS = 3;
const MAX_PER_RUN = 3;
const RETRY_MS = 60 * 60 * 1000;
// readReviews lists reviews finished within this long, and pendingReviews skips
// sessions that ended longer ago. Rows are never deleted, so a session that was
// reviewed once is never claimed again whether or not its snapshot is still there.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_REASONS = ['done', 'not_useful'];

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

// Ended sessions from the snapshots in cc-dashboard/sessions/, newest end first.
// bin/record-session-end sets endedAt when the mod sees session.end. A session that
// closed without session.end, such as a killed terminal, has no endedAt and is
// never reviewed.
function endedSessions(sessionsDir) {
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const ended = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = readJson(path.join(sessionsDir, name));
    if (typeof s?.sessionId !== 'string' || !SESSION_ID_PATTERN.test(s.sessionId) || typeof s.endedAt !== 'number') continue;
    ended.push({ sessionId: s.sessionId, project: typeof s.project === 'string' ? s.project : null, endedAt: s.endedAt });
  }
  return ended.sort((a, b) => b.endedAt - a.endedAt);
}

// Several sessions can start at once, and each one reviews what has ended. INSERT OR
// IGNORE adds the row only when no row for the session exists, so one claim wins. A
// claim left pending (the process exited mid-review) or a failed review can be
// claimed again after RETRY_MS. The retry is one UPDATE whose WHERE clause holds the
// RETRY_MS check and moves claimed_at to now, so two processes retaking the same
// row at the same moment cannot both win.
function claimReview(db, session, now = Date.now()) {
  const project = session.project ?? null;
  const inserted = db
    .prepare("INSERT OR IGNORE INTO reviews (session_id, project, ended_at, status, claimed_at) VALUES (?, ?, ?, 'pending', ?)")
    .run(session.sessionId, project, session.endedAt, now);
  if (inserted.changes === 1) return true;
  const retaken = db
    .prepare(
      `UPDATE reviews
          SET project = ?, ended_at = ?, status = 'pending', claimed_at = ?, reviewed_at = NULL,
              transcript = NULL, title = NULL, branch = NULL, skip_reason = NULL, error = NULL
        WHERE session_id = ? AND status IN ('pending', 'failed') AND claimed_at < ?`,
    )
    .run(project, session.endedAt, now, session.sessionId, now - RETRY_MS);
  return retaken.changes === 1;
}

// Writes the outcome and its suggestions to a claimed review in one transaction, so
// a reader never sees status 'done' without its suggestions. False when the review
// is not pending: it was never claimed, or a late caller lost it to a retaken claim
// that has already finished. A false return changes nothing, so the suggestions and
// dismissals of a finished review stay as they are.
function finishReview(db, id, outcome, now = Date.now()) {
  return transaction(db, () => {
    const updated = db
      .prepare('UPDATE reviews SET status = ?, reviewed_at = ?, skip_reason = ?, error = ? WHERE session_id = ? AND status = ?')
      .run(outcome.status, now, outcome.reason ?? null, outcome.error ?? null, id, 'pending');
    if (updated.changes !== 1) return false;
    db.prepare('DELETE FROM suggestions WHERE session_id = ?').run(id);
    const insert = db.prepare('INSERT INTO suggestions (session_id, idx, kind, text) VALUES (?, ?, ?, ?)');
    (outcome.suggestions ?? []).forEach((s, i) => insert.run(id, i, s.kind, s.text));
    return true;
  });
}

// Saves the transcript path, title and branch on a claimed review without marking it
// reviewed. finishReview sets reviewed_at, and readReviews skips a row that has none.
function updateReview(db, id, fields) {
  const res = db
    .prepare('UPDATE reviews SET transcript = ?, title = ?, branch = ? WHERE session_id = ?')
    .run(fields.transcript ?? null, fields.title ?? null, fields.branch ?? null, id);
  return res.changes === 1;
}

// The snapshot does not record the project folder, so every folder under
// projects/ is checked for <session id>.jsonl.
function findTranscript(id, projects) {
  let folders;
  try {
    folders = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const file = path.join(projects, folder.name, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Claude Code writes an ai-title line many times in a transcript, and the last one
// is the current title. Most other lines carry gitBranch, and the last one is the
// branch the session ended on. Each is null when the file has none or cannot be read.
async function readTitleAndBranch(file) {
  let title = null;
  let branch = null;
  try {
    await forEachLine(file, (line) => {
      if (!line.includes('"ai-title"') && !line.includes('"gitBranch"')) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed?.type === 'ai-title' && typeof parsed.aiTitle === 'string' && parsed.aiTitle.trim()) title = parsed.aiTitle.trim();
      if (typeof parsed?.gitBranch === 'string' && parsed.gitBranch) branch = parsed.gitBranch;
    });
  } catch {
    return { title: null, branch: null };
  }
  return { title, branch };
}

// Claims up to MAX_PER_RUN ended sessions and returns what to send Haiku for each.
// A session with no transcript, or under MIN_PROMPTS typed prompts, is recorded as
// skipped and does not count toward MAX_PER_RUN.
async function pendingReviews({ db, sessionsDir, projects, now = Date.now() }) {
  const reviews = [];
  for (const session of endedSessions(sessionsDir)) {
    if (reviews.length >= MAX_PER_RUN) break;
    if (now - session.endedAt > KEEP_MS) continue;
    if (!claimReview(db, session, now)) continue;
    const file = findTranscript(session.sessionId, projects);
    if (file) updateReview(db, session.sessionId, { transcript: file, ...(await readTitleAndBranch(file)) });
    const digest = file ? await digestTranscript(file) : null;
    if (!digest) {
      finishReview(db, session.sessionId, { status: 'skipped', reason: 'no transcript' }, now);
    } else if (digest.prompts < MIN_PROMPTS) {
      finishReview(db, session.sessionId, { status: 'skipped', reason: `under ${MIN_PROMPTS} prompts` }, now);
    } else {
      reviews.push({ sessionId: session.sessionId, system: SYSTEM, prompt: digest.text });
    }
  }
  return reviews;
}

// Records Haiku's answer, or the reason there is none.
function recordReview(db, input, now = Date.now()) {
  const { sessionId, reply, error } = input ?? {};
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) throw new Error('expected a session id');
  let outcome;
  if (typeof reply === 'string') {
    const suggestions = parseReview(reply);
    outcome = suggestions ? { status: 'done', suggestions } : { status: 'failed', error: 'Haiku did not answer in the asked-for format' };
  } else if (typeof error === 'string') {
    outcome = { status: 'failed', error: oneLine(error, ERROR_TEXT_LIMIT) };
  } else {
    throw new Error('expected {"sessionId", "reply"} or {"sessionId", "error"}');
  }
  if (!finishReview(db, sessionId, outcome, now)) throw new Error(`no claimed review for ${sessionId}`);
  return { status: outcome.status, suggestions: outcome.suggestions?.length ?? 0 };
}

// Done and failed reviews finished within KEEP_MS, newest end first. Skipped and
// pending reviews are left out. A review claimed before its transcript path was
// saved gets one from findTranscript. Each suggestion carries its idx, and
// dismissedAt and reason, which are null while it is open.
function readReviews(db, projects, now = Date.now()) {
  const since = now - KEEP_MS;
  const rows = db
    .prepare(
      `SELECT session_id, project, ended_at, status, reviewed_at, transcript, title, branch, error
         FROM reviews
        WHERE status IN ('done', 'failed') AND reviewed_at IS NOT NULL AND reviewed_at >= ?`,
    )
    .all(since);
  const bySession = new Map();
  const suggestionRows = db
    .prepare(
      `SELECT s.session_id, s.idx, s.kind, s.text, s.dismissed_at, s.reason
         FROM suggestions s JOIN reviews r ON r.session_id = s.session_id
        WHERE r.status IN ('done', 'failed') AND r.reviewed_at >= ?
        ORDER BY s.session_id, s.idx`,
    )
    .all(since);
  for (const s of suggestionRows) {
    if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
    bySession.get(s.session_id).push({ idx: s.idx, kind: s.kind, text: s.text, dismissedAt: s.dismissed_at, reason: s.reason });
  }
  const reviews = rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title || null,
    branch: r.branch || null,
    transcript: r.transcript || findTranscript(r.session_id, projects),
    project: r.project,
    endedAt: r.ended_at,
    reviewedAt: r.reviewed_at,
    status: r.status,
    suggestions: bySession.get(r.session_id) ?? [],
    ...(r.status === 'failed' && r.error ? { error: r.error } : {}),
  }));
  return reviews.sort((a, b) => (b.endedAt ?? b.reviewedAt) - (a.endedAt ?? a.reviewedAt));
}

// Marks one suggestion dismissed with a reason, or open again when reason is null.
// Dismissing a dismissed suggestion replaces its reason and time. False when the
// suggestion does not exist, so the caller can answer 404.
function setDismissal(db, sessionId, idx, reason, now = Date.now()) {
  if (reason === null) {
    return db.prepare('UPDATE suggestions SET dismissed_at = NULL, reason = NULL WHERE session_id = ? AND idx = ?').run(sessionId, idx).changes === 1;
  }
  if (!DISMISS_REASONS.includes(reason)) throw new Error(`reason must be one of ${DISMISS_REASONS.join(', ')}`);
  return db.prepare('UPDATE suggestions SET dismissed_at = ?, reason = ? WHERE session_id = ? AND idx = ?').run(now, reason, sessionId, idx).changes === 1;
}

module.exports = {
  KINDS, SYSTEM, KEEP_MS,
  DISMISS_REASONS, digestTranscript, parseReview, endedSessions, claimReview, finishReview, updateReview, readTitleAndBranch,
  findTranscript, pendingReviews, recordReview, readReviews, setDismissal,
};
