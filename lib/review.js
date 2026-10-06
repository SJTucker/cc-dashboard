'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProjectsDir, forEachLine, isTypedPrompt, toolDetail, resultText } = require('./scan');
const { SESSION_ID_PATTERN, getSessionsDir, writeAtomic } = require('./sessions');
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

const MIN_PROMPTS = 3;
const MAX_PER_RUN = 3;
const RETRY_MS = 60 * 60 * 1000;
// pruneReviews deletes review files older than this, and pendingReviews skips
// sessions that ended longer ago. A review file's mtime is never older than its
// session's endedAt, so a deleted review file never lets its session be claimed again,
// whether or not the 24 h snapshot prune in lib/sessions.js has run.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// pruneReviews deletes only names this module writes: a review or its tmp file.
const REVIEW_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}\.json(\.\d+)?$/;

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

function getReviewsDir() {
  if (process.env.REVIEWS_DIR) return process.env.REVIEWS_DIR.replace(/^~/, os.homedir());
  return path.join(path.dirname(getProjectsDir()), 'cc-dashboard', 'reviews');
}

const reviewFile = (dir, id) => path.join(dir, `${id}.json`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Ended sessions from the snapshots in cc-dashboard/sessions/, newest end first.
// bin/record-session-end sets endedAt when the mod sees session.end. A session that
// closed without session.end, such as a killed terminal, has no endedAt and is
// never reviewed.
function endedSessions(sessionsDir = getSessionsDir()) {
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

// Several sessions can start at once, and each one reviews what has ended. The 'wx'
// flag creates the file only when it does not exist, so one claim wins. A claim
// left pending (the process exited mid-review) or a failed review can be claimed
// again after an hour. Two processes that take back the same stale file at the
// same moment can both win, which costs one extra review.
function claimReview(session, dir = getReviewsDir(), now = Date.now()) {
  const file = reviewFile(dir, session.sessionId);
  const record = JSON.stringify({ ...session, status: 'pending', claimedAt: now });
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, record, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const existing = readJson(file);
  const retry = (existing?.status === 'pending' || existing?.status === 'failed') && now - existing.claimedAt > RETRY_MS;
  return retry ? writeAtomic(file, record) : false;
}

// Adds the outcome to a claimed review. False when there is no claim to add it to.
function finishReview(id, outcome, dir = getReviewsDir(), now = Date.now()) {
  const file = reviewFile(dir, id);
  const existing = readJson(file);
  if (!existing) return false;
  return writeAtomic(file, JSON.stringify({ ...existing, ...outcome, reviewedAt: now }));
}

// Adds fields to a claimed review without marking it reviewed. finishReview sets
// reviewedAt, and readReviews skips a review that has none.
function updateReview(id, fields, dir = getReviewsDir()) {
  const file = reviewFile(dir, id);
  const existing = readJson(file);
  return existing ? writeAtomic(file, JSON.stringify({ ...existing, ...fields })) : false;
}

// The snapshot does not record the project folder, so every folder under
// projects/ is checked for <session id>.jsonl.
function findTranscript(id, projects = getProjectsDir()) {
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

// Claude Code writes an ai-title line many times in a transcript, and the last
// one is the current title. Null when the file has none or cannot be read.
async function readTitle(file) {
  let title = null;
  try {
    await forEachLine(file, (line) => {
      if (!line.includes('"ai-title"')) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed?.type === 'ai-title' && typeof parsed.aiTitle === 'string' && parsed.aiTitle.trim()) title = parsed.aiTitle.trim();
    });
  } catch {
    return null;
  }
  return title;
}

// Claims up to MAX_PER_RUN ended sessions and returns what to send Haiku for each.
// A session with no transcript, or under MIN_PROMPTS typed prompts, is recorded as
// skipped and does not count toward MAX_PER_RUN.
async function pendingReviews({ sessionsDir = getSessionsDir(), dir = getReviewsDir(), projects = getProjectsDir(), now = Date.now() } = {}) {
  pruneReviews(dir, now);
  const reviews = [];
  for (const session of endedSessions(sessionsDir)) {
    if (reviews.length >= MAX_PER_RUN) break;
    if (now - session.endedAt > KEEP_MS) continue;
    if (!claimReview(session, dir, now)) continue;
    const file = findTranscript(session.sessionId, projects);
    if (file) updateReview(session.sessionId, { transcript: file, title: await readTitle(file) }, dir);
    const digest = file ? await digestTranscript(file) : null;
    if (!digest) {
      finishReview(session.sessionId, { status: 'skipped', reason: 'no transcript' }, dir, now);
    } else if (digest.prompts < MIN_PROMPTS) {
      finishReview(session.sessionId, { status: 'skipped', reason: `under ${MIN_PROMPTS} prompts` }, dir, now);
    } else {
      reviews.push({ sessionId: session.sessionId, system: SYSTEM, prompt: digest.text });
    }
  }
  return reviews;
}

// Records Haiku's answer, or the reason there is none.
function recordReview(input, dir = getReviewsDir(), now = Date.now()) {
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
  if (!finishReview(sessionId, outcome, dir, now)) throw new Error(`no claimed review for ${sessionId}`);
  return { status: outcome.status, suggestions: outcome.suggestions?.length ?? 0 };
}

// Done and failed reviews from the last KEEP_MS, newest end first. Skipped and
// pending reviews are left out. A review claimed before transcript and title were
// saved gets its transcript from findTranscript, and its title stays null.
function readReviews(dir = getReviewsDir(), now = Date.now(), projects = getProjectsDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const reviews = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const r = readJson(path.join(dir, name));
    if (!r || (r.status !== 'done' && r.status !== 'failed') || typeof r.reviewedAt !== 'number') continue;
    if (now - r.reviewedAt > KEEP_MS) continue;
    const suggestions = Array.isArray(r.suggestions)
      ? r.suggestions.filter((s) => s && KINDS.includes(s.kind) && typeof s.text === 'string')
      : [];
    reviews.push({
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : name.replace(/\.json$/, ''),
      title: typeof r.title === 'string' && r.title ? r.title : null,
      transcript: typeof r.transcript === 'string' && r.transcript ? r.transcript : findTranscript(path.basename(name, '.json'), projects),
      project: typeof r.project === 'string' ? r.project : null,
      endedAt: typeof r.endedAt === 'number' ? r.endedAt : null,
      reviewedAt: r.reviewedAt,
      status: r.status,
      suggestions,
      ...(r.status === 'failed' && typeof r.error === 'string' ? { error: r.error } : {}),
    });
  }
  return reviews.sort((a, b) => (b.endedAt ?? b.reviewedAt) - (a.endedAt ?? a.reviewedAt));
}

function pruneReviews(dir = getReviewsDir(), now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!REVIEW_NAME_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_MS) fs.unlinkSync(file);
    } catch {
      // Another session pruned it first.
    }
  }
}

module.exports = {
  KINDS, SYSTEM,
  getReviewsDir, digestTranscript, parseReview, endedSessions, claimReview, finishReview, updateReview, readTitle,
  findTranscript, pendingReviews, recordReview, readReviews, pruneReviews,
};
