// Pure helpers for the Session reviews panel (public/panels/reviews.mjs and
// public/panels/reviews-closed.mjs).

const isOpen = (s) => s.dismissedAt == null;
const openSuggestions = (review) => review.suggestions.filter(isOpen);
const countWithOpen = (reviews) => reviews.filter((r) => openSuggestions(r).length > 0).length;

// The one-line text of a suggestion closed in the open list.
const DISMISSAL_TEXT = { done: 'Marked done', not_useful: 'Marked not useful', duplicate: 'Marked duplicate', expired: 'Expired' };
const dismissalText = (s) => DISMISSAL_TEXT[s.reason] ?? 'Marked not useful';
// The reason of a suggestion in the closed list, as a word. Words, not colours, tell
// the reasons apart.
const REASON_LABEL = { done: 'Done', duplicate: 'Duplicate', not_useful: 'Not useful', expired: 'Expired' };
const reasonLabel = (s) => REASON_LABEL[s.reason] ?? s.reason;

// The range picker's value ('today', '7', '30', '90' or 'all') in a sentence and in
// the panel note.
const RANGE_PHRASE = { all: 'in all time', today: 'today' };
const RANGE_SHORT = { all: 'All', today: 'Today' };
const rangePhrase = (days) => RANGE_PHRASE[days] ?? `in the last ${days} days`;
const rangeShort = (days) => RANGE_SHORT[days] ?? `${days}d`;

// Newest first. The open list sorts by session end. The closed list sorts by the
// server's cursor: reviewedAt, then session id descending. SQLite compares session
// ids byte by byte, and so does < on these ASCII strings.
const byEnd = (a, b) => (b.endedAt ?? b.reviewedAt) - (a.endedAt ?? a.reviewedAt);
const byCursor = (a, b) => b.reviewedAt - a.reviewedAt || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0);

// Returns list with suggestion (in its new state) put into review's entry, by idx.
// A suggestion already in the list is replaced. One the list does not hold is added
// only when insert is set: to its review's entry, or in a new entry placed in order.
// A new entry is not added when it would land after the last entry while more pages
// remain (hasMore), because its own page will bring it. The input list and its
// entries are left unchanged.
function upsertSuggestion(list, review, suggestion, { order, insert, hasMore = false }) {
  const at = list.findIndex((r) => r.sessionId === review.sessionId);
  if (at >= 0) {
    const held = list[at].suggestions.some((s) => s.idx === suggestion.idx);
    if (!held && !insert) return list;
    const suggestions = [...list[at].suggestions.filter((s) => s.idx !== suggestion.idx), suggestion].sort((a, b) => a.idx - b.idx);
    return list.with(at, { ...list[at], suggestions });
  }
  if (!insert) return list;
  const entry = { ...review, suggestions: [suggestion] };
  const last = list.at(-1);
  if (hasMore && last && order(entry, last) > 0) return list;
  return [...list, entry].sort(order);
}

// The prompt the Copy prompt button puts on the clipboard, for a stronger model to
// check Haiku's open suggestions against the transcript. Null without a transcript
// path or an open suggestion, because there is nothing left to check.
function reviewPrompt(review) {
  const open = openSuggestions(review);
  if (!review.transcript || !open.length) return null;
  const lines = open.map((s) => `- ${s.text}`).join('\n');
  return `Review the Claude Code session transcript at ${review.transcript}. A Haiku review of it suggested:\n${lines}\nWhich of these are right, which are wrong, and what did it miss?`;
}

export { reviewPrompt, openSuggestions, countWithOpen, dismissalText, reasonLabel, rangePhrase, rangeShort, byEnd, byCursor, upsertSuggestion };
