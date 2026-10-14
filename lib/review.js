'use strict';

const fs = require('fs');
const path = require('path');
const { forEachLine, isTypedPrompt, toolDetail, resultText } = require('./transcript-lines');
const { SESSION_ID_PATTERN } = require('./session-id');
const { stripFence } = require('./updates');
const { transaction, DISMISS_REASONS } = require('./db');
const { readJson } = require('./files');
const { RULES_HEADER, DIGEST_HEADER, EARLIER_HEADER, CHANGED_NOTE, ruleFiles, memoryIndexPath, rulesText, reviewPrompt } = require('./review-rules');

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
// An open suggestion closes as expired once its review finished this long ago
// (expireSuggestions). pendingReviews sends Haiku the suggestions from reviews
// finished within the same window, newest review first, cut to EARLIER_CHARS on a
// whole line, so a suggestion leaves EARLIER SUGGESTIONS when it expires.
const EXPIRE_MS = 14 * 24 * 60 * 60 * 1000;
const EARLIER_MS = EXPIRE_MS;
const EARLIER_CHARS = 12_000;
const STATE_WORDS = { done: 'done', not_useful: 'not useful', duplicate: 'duplicate', expired: 'expired' };

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
  `The prompt may start with ${RULES_HEADER}: the CLAUDE.md files and memory index Claude had in this session, each under a line "=== path ===". ${DIGEST_HEADER} follows them.`,
  'Do not suggest adding a rule those files already state.',
  'When the digest shows Claude broke one of those rules, report it as kind "claude-md" with text that starts "Broken rule:", names the rule and says what happened. A hook that enforces a broken rule is still a valid "skill-or-hook" suggestion.',
  `A file marked "${CHANGED_NOTE}" may hold rules added after the session. Do not report a rule from it as broken.`,
  `The prompt may also hold ${EARLIER_HEADER}: suggestions from reviews of other sessions, one per line, each marked open, done, not useful, duplicate or expired.`,
  'Do not make a suggestion that proposes the same change as one of those lines, whatever its mark. "not useful" means the user rejected that change.',
  'When the digest shows the problem behind an open or done suggestion happening again, you may repeat that suggestion with text that starts "Recurring:".',
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

// A CLAUDE line holding the first REPLY_TEXT_LIMIT characters of an assistant text
// block, or null when the block's text is empty.
function claudeLine(block) {
  if (typeof block.text !== 'string' || !block.text.trim()) return null;
  return `CLAUDE: ${oneLine(block.text, REPLY_TEXT_LIMIT)}`;
}

// A TOOL line, or null for a tool_use block already listed. A response can repeat a
// block on a later line. The name is kept for resultLine's ERROR or LARGE OUTPUT line.
function toolLine(digest, block) {
  if (block.id && digest.toolNames.has(block.id)) return null;
  const name = block.name || 'unknown';
  if (block.id) digest.toolNames.set(block.id, name);
  const detail = toolDetail(name, block.input);
  return detail ? `TOOL ${name} ${detail}` : `TOOL ${name}`;
}

// An ERROR line for a failed tool call, a LARGE OUTPUT line for a result over
// LARGE_OUTPUT_CHARS, or null.
function resultLine(digest, block) {
  const name = digest.toolNames.get(block.tool_use_id) || 'tool';
  const text = resultText(block.content);
  if (block.is_error) return `ERROR ${name}: ${oneLine(text, ERROR_TEXT_LIMIT)}`;
  if (text.length > LARGE_OUTPUT_CHARS) return `LARGE OUTPUT ${name}: ${text.length} chars`;
  return null;
}

function blockLine(digest, type, block) {
  if (type === 'assistant' && block.type === 'text') return claudeLine(block);
  if (type === 'assistant' && block.type === 'tool_use') return toolLine(digest, block);
  if (type === 'user' && block.type === 'tool_result') return resultLine(digest, block);
  return null;
}

// The facts one pass over a transcript gathers besides the digest: the last
// ai-title, the last gitBranch, and the first cwd and timestamp. Every JSON line
// counts, sidechain and compact-summary lines included.
function factsLine(facts, parsed) {
  if (typeof parsed !== 'object') return;
  if (parsed.type === 'ai-title' && typeof parsed.aiTitle === 'string' && parsed.aiTitle.trim()) facts.title = parsed.aiTitle.trim();
  if (typeof parsed.gitBranch === 'string' && parsed.gitBranch) facts.branch = parsed.gitBranch;
  if (!facts.cwd && typeof parsed.cwd === 'string' && parsed.cwd) facts.cwd = parsed.cwd;
  if (facts.startedAt === null && typeof parsed.timestamp === 'string') {
    const at = Date.parse(parsed.timestamp);
    if (Number.isFinite(at)) facts.startedAt = at;
  }
}

function digestLine(digest, line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // a line caught mid-write
  }
  if (!parsed) return;
  factsLine(digest.facts, parsed);
  if (parsed.isSidechain || parsed.isCompactSummary) return;
  if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
    digest.lines.push('COMPACTED');
    return;
  }
  if (isTypedPrompt(parsed)) {
    digest.prompts++;
    digest.lines.push(`USER: ${oneLine(parsed.message.content, PROMPT_TEXT_LIMIT)}`);
    return;
  }
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block) continue;
    const out = blockLine(digest, parsed.type, block);
    if (out) digest.lines.push(out);
  }
}

// $.model.complete takes no history, so the transcript goes into the prompt. A
// whole transcript can exceed Haiku's context, so it is cut down to one line per
// typed prompt, reply start, tool call, tool error, large tool result and
// compaction. Subagent lines are left out. Null when the file cannot be read.
// One pass also gives the title, branch, start folder and start time.
async function readTranscript(file) {
  const facts = { title: null, branch: null, cwd: null, startedAt: null };
  const digest = { lines: [], toolNames: new Map(), prompts: 0, facts };
  const ok = await forEachLine(file, (line) => digestLine(digest, line));
  if (!ok) return null;
  return { prompts: digest.prompts, text: cutDigest(digest.lines.join('\n')), ...facts };
}

async function digestTranscript(file) {
  const read = await readTranscript(file);
  return read && { prompts: read.prompts, text: read.text };
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

// The SQL whose plans test/review.test.js checks. None may scan suggestions except
// through suggestions_open, and none may sort into a temp B-tree.
const QUERIES = {
  // The scalar subquery keeps suggestions_open as the outer loop, with one
  // primary-key lookup into reviews per open row. An IN (SELECT ... WHERE
  // reviewed_at < ?) form walks every old review instead, which grows with the table.
  expire: `UPDATE suggestions SET reason = 'expired', dismissed_at = ?
            WHERE reason IS NULL
              AND (SELECT r.reviewed_at FROM reviews r WHERE r.session_id = suggestions.session_id) < ?`,
  // CROSS JOIN keeps suggestions as the outer loop, so the read starts from
  // suggestions_open and looks each review up by primary key.
  open: `SELECT r.session_id, r.project, r.ended_at, r.reviewed_at, r.transcript, r.title, r.branch, s.idx, s.kind, s.text
           FROM suggestions s CROSS JOIN reviews r ON r.session_id = s.session_id
          WHERE s.reason IS NULL AND r.status = 'done' AND r.reviewed_at >= ?`,
  // Walks the range in reviews_reviewed_at_id. On All that is every review.
  closedCount: `SELECT COUNT(*) AS n
                  FROM reviews r CROSS JOIN suggestions s ON s.session_id = r.session_id
                 WHERE r.status = 'done' AND r.reviewed_at >= ? AND s.reason IS NOT NULL`,
  // Walks reviews_reviewed_at_id newest first from the cursor and stops after the
  // page, so a page costs the same however many reviews are older.
  closedPage: `SELECT r.session_id, r.project, r.ended_at, r.reviewed_at, r.transcript, r.title, r.branch
                 FROM reviews r
                WHERE r.status = 'done' AND r.reviewed_at >= ? AND (r.reviewed_at, r.session_id) < (?, ?)
                  AND EXISTS (SELECT 1 FROM suggestions s WHERE s.session_id = r.session_id AND s.reason IS NOT NULL)
                ORDER BY r.reviewed_at DESC, r.session_id DESC
                LIMIT ?`,
  closedOf: `SELECT idx, kind, text, dismissed_at, reason FROM suggestions
              WHERE session_id = ? AND reason IS NOT NULL ORDER BY idx`,
};

// Closes every open suggestion whose review finished more than EXPIRE_MS ago, with
// the reason expired. bin/review-session runs it at the start of each prompt run.
// Returns the number of suggestions closed.
function expireSuggestions(db, now = Date.now()) {
  return Number(db.prepare(QUERIES.expire).run(now, now - EXPIRE_MS).changes);
}

// One line per suggestion from a done review finished within EARLIER_MS, from every
// project, with its state. reviews.project is a folder name, which doesn't identify
// a repo, and most repeats come from global rules. Whole lines past EARLIER_CHARS are
// dropped, so the newest stay.
function earlierSuggestions(db, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT s.kind, s.text, s.reason
         FROM suggestions s JOIN reviews r ON r.session_id = s.session_id
        WHERE r.status = 'done' AND r.reviewed_at >= ?
        ORDER BY r.reviewed_at DESC, s.session_id, s.idx`,
    )
    .all(now - EARLIER_MS);
  const lines = [];
  let length = 0;
  for (const s of rows) {
    const line = `- [${STATE_WORDS[s.reason] ?? 'open'}] ${s.kind}: ${oneLine(s.text, SUGGESTION_TEXT_LIMIT)}`;
    if (length + line.length + 1 > EARLIER_CHARS) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

// Claims up to MAX_PER_RUN ended sessions and returns what to send Haiku for each.
// A session with no transcript, or under MIN_PROMPTS typed prompts, is recorded as
// skipped and does not count toward MAX_PER_RUN. Each prompt starts with the rule
// files the session had, from lib/review-rules.js, then the earlier suggestions.
async function pendingReviews({ db, sessionsDir, projects, configDir = null, now = Date.now() }) {
  const reviews = [];
  const earlier = earlierSuggestions(db, now);
  for (const session of endedSessions(sessionsDir)) {
    if (reviews.length >= MAX_PER_RUN) break;
    if (now - session.endedAt > KEEP_MS) continue;
    if (!claimReview(db, session, now)) continue;
    const file = findTranscript(session.sessionId, projects);
    const read = file ? await readTranscript(file) : null;
    if (file) updateReview(db, session.sessionId, { transcript: file, title: read?.title, branch: read?.branch });
    if (!read) {
      finishReview(db, session.sessionId, { status: 'skipped', reason: 'no transcript' }, now);
    } else if (read.prompts < MIN_PROMPTS) {
      finishReview(db, session.sessionId, { status: 'skipped', reason: `under ${MIN_PROMPTS} prompts` }, now);
    } else {
      const files = ruleFiles({ configDir, cwd: read.cwd, startedAt: read.startedAt, memoryIndex: memoryIndexPath({ projects, cwd: read.cwd, transcript: file }) });
      reviews.push({ sessionId: session.sessionId, system: SYSTEM, prompt: reviewPrompt(rulesText(files), read.text, earlier) });
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

const DAY_MS = 24 * 60 * 60 * 1000;
// Reviews per closed page, unless the request asks for another number, and the most
// one request may ask for.
const CLOSED_PAGE_SIZE = 10;
const CLOSED_PAGE_MAX = 50;

// The first reviewed_at a range includes. days null is All.
const rangeStart = (days, now) => (days == null ? 0 : now - days * DAY_MS);

const suggestionJson = (s) => ({ idx: s.idx, kind: s.kind, text: s.text, dismissedAt: s.dismissed_at, reason: s.reason });

// One review as the API sends it. A review claimed before its transcript path was
// saved gets one from findTranscript.
function reviewJson(r, projects, suggestions) {
  return {
    sessionId: r.session_id,
    title: r.title || null,
    branch: r.branch || null,
    transcript: r.transcript || findTranscript(r.session_id, projects),
    project: r.project,
    endedAt: r.ended_at,
    reviewedAt: r.reviewed_at,
    suggestions,
  };
}

// Done reviews that finished within the range (days null is All) and still have an
// open suggestion, newest session end first, each with its open suggestions only.
// closedCount is the number of closed suggestions on done reviews in the range.
// Failed reviews and reviews with no suggestions are left out.
function readReviews(db, projects, { days = 7, now = Date.now() } = {}) {
  const since = rangeStart(days, now);
  const bySession = new Map();
  for (const row of db.prepare(QUERIES.open).all(since)) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, { row, suggestions: [] });
    bySession.get(row.session_id).suggestions.push(suggestionJson({ ...row, dismissed_at: null, reason: null }));
  }
  const reviews = [...bySession.values()].map(({ row, suggestions }) => reviewJson(row, projects, suggestions.sort((a, b) => a.idx - b.idx)));
  reviews.sort((a, b) => (b.endedAt ?? b.reviewedAt) - (a.endedAt ?? a.reviewedAt));
  return { reviews, closedCount: db.prepare(QUERIES.closedCount).get(since).n };
}

// One page of done reviews in the range that have a closed suggestion, newest
// reviewed_at first, each with its closed suggestions only. before is the cursor of
// the last review on the previous page, or null for the first page. One extra row
// is read to learn whether another page exists.
function readClosedPage(db, projects, { days = 7, before = null, limit = CLOSED_PAGE_SIZE, now = Date.now() } = {}) {
  const [atBefore, idBefore] = before ? [before.reviewedAt, before.sessionId] : [Number.MAX_SAFE_INTEGER, ''];
  const rows = db.prepare(QUERIES.closedPage).all(rangeStart(days, now), atBefore, idBefore, limit + 1);
  const page = rows.slice(0, limit);
  const closedOf = db.prepare(QUERIES.closedOf);
  const reviews = page.map((r) => reviewJson(r, projects, closedOf.all(r.session_id).map(suggestionJson)));
  const last = page.at(-1);
  return { reviews, next: rows.length > limit ? `${last.reviewed_at}:${last.session_id}` : null };
}

// A closed page's next value, "<reviewedAt>:<sessionId>", as { reviewedAt, sessionId },
// or null when it is anything else.
function parseCursor(raw) {
  const m = typeof raw === 'string' ? /^(\d{1,16}):(.+)$/.exec(raw) : null;
  if (!m || !SESSION_ID_PATTERN.test(m[2])) return null;
  const reviewedAt = Number(m[1]);
  return Number.isSafeInteger(reviewedAt) ? { reviewedAt, sessionId: m[2] } : null;
}

// One suggestion's reason: a string when closed, null while open, undefined when the
// suggestion does not exist.
function suggestionReason(db, sessionId, idx) {
  const row = db.prepare('SELECT reason FROM suggestions WHERE session_id = ? AND idx = ?').get(sessionId, idx);
  return row ? row.reason : undefined;
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
  KINDS, SYSTEM, KEEP_MS, EXPIRE_MS, QUERIES, expireSuggestions,
  CLOSED_PAGE_SIZE, CLOSED_PAGE_MAX, readClosedPage, parseCursor, suggestionReason,
  DISMISS_REASONS, digestTranscript, parseReview, endedSessions, claimReview, finishReview, updateReview, readTranscript,
  findTranscript, earlierSuggestions, pendingReviews, recordReview, readReviews, setDismissal,
};
