// The Session reviews panel: suggestions from reviews of ended sessions, with
// dismiss, undo and Copy prompt.
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { formatAgo, localDateStr } from '../format.mjs';
import { createDrawGuard } from '../guards.mjs';
import { REVIEW_DAYS } from '../constants.mjs';
import { contextLine } from './sessions.mjs';

// Draw guard for Session reviews, which renderPayload draws on every settled
// response. redrawCharts leaves it alone, because a change of width does not
// change a table.
const reviewsGuard = createDrawGuard();

// Reviews of ended sessions from the last REVIEW_DAYS days (see lib/review.js). A
// server error resolves to { error } so the panel shows the reason. A network
// failure (status 0) resolves to null and hides the panel, like requestSessions.
export function requestReviews() {
  return getJson('/api/reviews').then((reviews) => (reviews.error && reviews.status === 0 ? null : reviews));
}

const REVIEW_KINDS = {
  'claude-md': 'CLAUDE.md',
  'skill-or-hook': 'Skill or hook',
  'token-waste': 'Token waste',
  workflow: 'Workflow',
};

// "5m ago" or a time for today, and a weekday with a time for earlier days.
function reviewTime(ms, now) {
  if (localDateStr(new Date(ms)) === localDateStr(new Date(now))) return formatAgo(ms, now);
  // A review can be about 8 days old, so past 6 days a weekday alone is ambiguous.
  const older = now - ms > 6 * 24 * 60 * 60 * 1000;
  const parts = older ? { month: 'short', day: 'numeric' } : { weekday: 'short' };
  return new Date(ms).toLocaleString([], { ...parts, hour: '2-digit', minute: '2-digit' });
}

// The last reviews payload shown. Dismiss and undo change it in place and redraw
// without a request.
let lastReviews = null;
// Counts local dismiss and undo actions (see reviewsSince).
let reviewMutations = 0;
// Session ids whose "N dismissed" list is showing, and session ids whose collapsed
// all-dismissed review is expanded. The 5 s redraw reads both.
const reviewDismissedShown = new Set();
const reviewExpanded = new Set();
// Session id -> "Copied" or "Copy failed" while it shows, for the label's 2 s.
const reviewCopyResults = new Map();
// The control to focus after the next draw, set by an action that removes the
// control the user was on. Otherwise the focused control is found again by its key.
let reviewFocusKey = null;
// The text of a failed dismiss or undo, shown in #reviewsStatus.
let reviewActionError = null;

// fetchAll calls reviewsMark() before its requests and reviewsSince(mark, fetched)
// after them. A dismiss or undo in between makes the fetched reviews older than
// the page, so reviewsSince returns lastReviews, the reviews on screen, which the
// action changed in place. A slow poll therefore cannot put a dismissed
// suggestion back. The next poll shows the saved state.
export const reviewsMark = () => reviewMutations;
export const reviewsSince = (mark, fetched) => (reviewMutations === mark ? fetched : lastReviews);

const reviewButton = (label, focusKey, ariaLabel, onClick, cls = 'refresh-btn') => {
  const button = el('button', { type: 'button', class: cls, text: label, 'data-review-focus': focusKey });
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
};

const suggestionName = (s) => `${REVIEW_KINDS[s.kind] || s.kind}: ${s.text.length > 80 ? `${s.text.slice(0, 79)}…` : s.text}`;

async function copyReviewPrompt(id, prompt) {
  reviewCopyResults.set(id, await navigator.clipboard.writeText(prompt).then(() => 'Copied', () => 'Copy failed'));
  const show = (label) => {
    const button = [...document.querySelectorAll('[data-review-focus]')].find((b) => b.dataset.reviewFocus === `copy:${id}`);
    if (button) button.textContent = label;
  };
  show(reviewCopyResults.get(id));
  setTimeout(() => {
    reviewCopyResults.delete(id);
    show('Copy prompt');
  }, 2000);
}

// Sends a dismissal (POST) or its undo (DELETE, when reason is null). Resolves to
// the server's answer, or to { error } when the request or the server failed.
async function sendDismissal(review, suggestion, reason) {
  const url = `/api/reviews/${encodeURIComponent(review.sessionId)}/suggestions/${suggestion.idx}/dismiss`;
  const init = reason
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }
    : { method: 'DELETE' };
  const res = await fetch(url, init).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  if (res && res.ok && body && body.ok) return body;
  return { error: (body && body.error) || 'the request failed' };
}

// A poll that landed during the request replaced lastReviews, so the suggestion
// captured at click time may no longer be the one on screen. Writes the answer to
// both, and returns the review on screen now, found by session.
function applyDismissal(review, suggestion, answer) {
  const currentReview = lastReviews?.reviews?.find((r) => r.sessionId === review.sessionId) ?? review;
  const current = currentReview.suggestions.find((s) => s.idx === suggestion.idx);
  for (const target of new Set([suggestion, current])) {
    if (!target) continue;
    target.dismissedAt = answer.dismissedAt;
    target.reason = answer.reason;
  }
  return currentReview;
}

// The button the user pressed is about to leave the page. Dismiss moves focus to
// the next open suggestion's Done button, else to the control that replaced it.
// Undo moves focus to the restored suggestion's Done button.
function focusAfterDismissal(currentReview, review, suggestion, reason) {
  if (!reason) return `done:${review.sessionId}:${suggestion.idx}`;
  const nextOpen = openSuggestions(currentReview).find((s) => s.idx !== suggestion.idx);
  if (nextOpen) return `done:${review.sessionId}:${nextOpen.idx}`;
  return allDismissed(currentReview) ? `toggle:${review.sessionId}` : `shown:${review.sessionId}`;
}

// Dismisses a suggestion, or undoes its dismissal when reason is null, then
// redraws. A failure leaves the suggestion as it was and shows why.
async function changeSuggestion(review, suggestion, reason) {
  const answer = await sendDismissal(review, suggestion, reason);
  if (answer.error) {
    reviewActionError = `Could not ${reason ? 'dismiss' : 'undo the dismissal of'} "${suggestionName(suggestion)}": ${answer.error}`;
  } else {
    reviewActionError = null;
    const currentReview = applyDismissal(review, suggestion, answer);
    reviewMutations++;
    reviewFocusKey = focusAfterDismissal(currentReview, review, suggestion, reason);
  }
  renderReviews(lastReviews);
}

function toggleSet(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
  renderReviews(lastReviews);
}

function dismissedList(review) {
  return el('ul', { class: 'review-dismissed' }, dismissedSuggestions(review).map((s) => el('li', {}, [
    el('span', { class: 'review-kind', text: REVIEW_KINDS[s.kind] || s.kind }),
    document.createTextNode(` ${s.text} `),
    el('span', { class: 'review-dismissal', text: `(${dismissalText(s)})` }),
    document.createTextNode(' '),
    reviewButton('Undo', `undo:${review.sessionId}:${s.idx}`, `Undo dismissal: ${suggestionName(s)}`, () => changeSuggestion(review, s, null)),
  ])));
}

function openList(review) {
  return el('ul', { class: 'review-suggestions' }, openSuggestions(review).map((s) => el('li', {}, [
    el('span', { class: 'review-kind', text: REVIEW_KINDS[s.kind] || s.kind }),
    document.createTextNode(` ${s.text} `),
    el('span', { class: 'review-actions' }, [
      reviewButton('Done', `done:${review.sessionId}:${s.idx}`, `Mark done: ${suggestionName(s)}`, () => changeSuggestion(review, s, 'done')),
      reviewButton('Not useful', `notuseful:${review.sessionId}:${s.idx}`, `Dismiss as not useful: ${suggestionName(s)}`, () => changeSuggestion(review, s, 'not_useful')),
    ]),
  ])));
}

// The body of one review: the open suggestions, then a "N dismissed · Show" line
// with the dismissed list under it when shown. A review with every suggestion
// dismissed shows a toggle line above the dismissed list instead.
function reviewBody(r) {
  if (r.status === 'failed') return [el('p', { class: 'review-empty', text: `Review failed: ${r.error || 'no reason recorded'}` })];
  if (!r.suggestions.length) return [el('p', { class: 'review-empty', text: 'No suggestions' })];
  if (allDismissed(r)) {
    const hide = reviewButton(`All ${r.suggestions.length} dismissed · Hide`, `toggle:${r.sessionId}`, null, () => toggleSet(reviewExpanded, r.sessionId), 'review-toggle');
    hide.setAttribute('aria-expanded', 'true');
    return [hide, dismissedList(r)];
  }
  const parts = [openList(r)];
  const dismissed = dismissedSuggestions(r);
  if (dismissed.length) {
    const shown = reviewDismissedShown.has(r.sessionId);
    const toggle = reviewButton(shown ? 'Hide' : 'Show', `shown:${r.sessionId}`, `${shown ? 'Hide' : 'Show'} ${dismissed.length} dismissed ${dismissed.length === 1 ? 'suggestion' : 'suggestions'}`, () => toggleSet(reviewDismissedShown, r.sessionId), 'review-toggle');
    toggle.setAttribute('aria-expanded', String(shown));
    parts.push(el('p', { class: 'review-dismissed-line' }, [document.createTextNode(`${dismissed.length} dismissed · `), toggle]));
    if (shown) parts.push(dismissedList(r));
  }
  return parts;
}

// A review with every suggestion dismissed is one button line until expanded. The
// button is keyboard-operable and carries aria-expanded.
function collapsedReview(r, now) {
  const name = r.title || r.project || r.sessionId;
  const label = `${name} · ended ${reviewTime(r.endedAt ?? r.reviewedAt, now)} · all ${r.suggestions.length} ${r.suggestions.length === 1 ? 'suggestion' : 'suggestions'} dismissed · Show`;
  const button = reviewButton(label, `toggle:${r.sessionId}`, null, () => toggleSet(reviewExpanded, r.sessionId), 'review-toggle');
  button.setAttribute('aria-expanded', 'false');
  return el('li', { class: 'review review-collapsed' }, [button]);
}

// Shown on every range, because a review belongs to a session, not to a day.
// Hidden when the request failed or no session was reviewed in the last 7 days.
// A server error shows its text in place of the list.
export function renderReviews(data) {
  lastReviews = data;
  // The key holds every input of the draw, so a dismiss, an undo, a Show or Hide
  // toggle and a failed action each redraw from their own call.
  reviewsGuard.draw(
    [data, reviewMutations, [...reviewDismissedShown], [...reviewExpanded], reviewActionError],
    () => drawReviews(data)
  );
}

function drawReviews(data) {
  const panel = document.getElementById('reviewsPanel');
  const status = document.getElementById('reviewsStatus');
  const list = document.getElementById('reviewsList');
  if (data && data.error) {
    panel.hidden = false;
    status.hidden = false;
    status.textContent = `Could not read session reviews: ${data.error}`;
    list.replaceChildren();
    document.getElementById('reviewsNote').textContent = '';
    return;
  }
  panel.hidden = !data || !data.reviews.length;
  if (panel.hidden) return;

  const active = document.activeElement;
  const focusKey = reviewFocusKey || (active && list.contains(active) ? active.dataset.reviewFocus : null);
  reviewFocusKey = null;
  status.hidden = !reviewActionError;
  status.textContent = reviewActionError || '';

  const now = Date.now();
  const items = data.reviews.map((r) => {
    if (allDismissed(r) && !reviewExpanded.has(r.sessionId)) return collapsedReview(r, now);
    const ended = ` · ended ${reviewTime(r.endedAt ?? r.reviewedAt, now)}`;
    const head = el('div', { class: 'review-head' }, [
      ...(r.title ? [el('span', { class: 'session-title', title: r.title, text: r.title })] : []),
      contextLine(r, ended),
    ]);
    const prompt = reviewPrompt(r);
    let source = null;
    if (r.transcript) {
      const children = [el('span', { class: 'review-path', title: r.transcript, text: shortPath(r.transcript, data.home) })];
      if (prompt) {
        children.push(reviewButton(reviewCopyResults.get(r.sessionId) || 'Copy prompt', `copy:${r.sessionId}`, null, () => copyReviewPrompt(r.sessionId, prompt)));
      }
      source = el('div', { class: 'review-source' }, children);
    }
    return el('li', { class: 'review' }, [head, ...(source ? [source] : []), ...reviewBody(r)]);
  });
  list.replaceChildren(...items);
  if (focusKey) [...list.querySelectorAll('[data-review-focus]')].find((n) => n.dataset.reviewFocus === focusKey)?.focus();

  document.getElementById('reviewsNote').textContent =
    `${data.reviews.length} in the last ${REVIEW_DAYS} days · ${countWithOpen(data.reviews)} with open suggestions`;
}
