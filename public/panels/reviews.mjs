// The Session reviews panel: open suggestions from reviews of ended sessions in the
// range picker's range, with Done, Duplicate, Not useful, Undo and Copy prompt.
// Closed suggestions load a page at a time in reviews-closed.mjs.
import { getJson } from '../api.mjs';
import { el, withTooltip, withFocusTooltip } from '../dom.mjs';
import { createDrawGuard } from '../guards.mjs';
import { reviewPrompt, countWithOpen, dismissalText, rangePhrase, rangeShort, byEnd, upsertSuggestion } from '../reviews.mjs';
import { visibleRows, showAllButton, refocusShowAll, keepShowAllFocus } from '../ui/show-all.mjs';
import { contextLine } from './sessions.mjs';
import { kindName, reviewTime, iconButton, reviewTip, TIP_UNDO, suggestionName, dismissButtons, sendDismissal } from './review-ui.mjs';
import { resetClosed, updateClosed, drawClosed, closedVersion } from './reviews-closed.mjs';

// Draw guard for Session reviews. redrawCharts leaves it alone, because a change of
// width does not change a list.
const reviewsGuard = createDrawGuard();

// The range of the last request: '7', '30', '90' or 'all'.
let reviewsDays = '7';

// Open suggestions in the range (see lib/review.js readReviews). A new request
// hides the closed list and drops its pages. A server error resolves to { error }
// so the panel shows the reason. A network failure (status 0) resolves to null and
// hides the panel, like requestSessions.
export function requestReviews(days) {
  reviewsDays = String(days);
  resetClosed(reviewsDays);
  return getJson(`/api/reviews?days=${encodeURIComponent(reviewsDays)}`).then((reviews) => (reviews?.error && reviews.status === 0 ? null : reviews));
}

// The payload main.mjs last passed in, and the reviews on screen. Dismiss and undo
// replace lastReviews and redraw without a request. renderPayload in main.mjs passes
// a loaded payload again on a resize, and the set below keeps local changes.
let lastReviews = null;
// Every object lastReviews has held. renderReviews gets a payload from before a local
// change as often as a new one (reviewsSince can return an older object, and the
// payload main.mjs stores can lag), so it replaces lastReviews only with an object
// outside this set. A server response is always a new object.
const heldReviews = new WeakSet();
function holdReviews(reviews) {
  lastReviews = reviews;
  if (reviews && typeof reviews === 'object') heldReviews.add(reviews);
}
// Keys (`sessionId:idx`) of dismiss and undo requests in flight. A second click on
// the same suggestion is ignored until the first request settles.
const changesInFlight = new Set();
// Counts local dismiss and undo actions (see reviewsSince).
let reviewMutations = 0;
// Session id -> "Copied" or "Copy failed" while it shows, for the label's 2 s.
const reviewCopyResults = new Map();
// The control to focus after the next draw, set by an action that removes the
// control the user was on. Otherwise the focused control is found again by its key.
let reviewFocusKey = null;
// The text of a failed dismiss or undo, shown in #reviewsStatus.
let reviewActionError = null;
// The panel shows REVIEWS_LIMIT reviews, newest first, until Show all.
const REVIEWS_LIMIT = 5;
let showAllReviews = false;

// fetchAll calls reviewsMark() before its requests and reviewsSince(mark, fetched)
// after them. A dismiss or undo in between makes the fetched reviews older than the
// page, so reviewsSince returns lastReviews, the reviews on screen.
export const reviewsMark = () => reviewMutations;
export const reviewsSince = (mark, fetched) => (reviewMutations === mark ? fetched : lastReviews);

const TIP_COPY = reviewTip('Copy prompt', 'Copies a prompt for a new Claude Code session.', 'It gives Claude this transcript and the open suggestions,', 'and asks which are right and what Haiku missed.');

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

// Sends a dismissal, a new reason or an undo (reason null) from either list, then
// puts the answer into both lists and redraws. closedCount moves by one when a
// suggestion opens or closes. A failure leaves both lists as they were and shows why.
async function changeSuggestion(review, suggestion, reason, focusKey) {
  const key = `${review.sessionId}:${suggestion.idx}`;
  if (changesInFlight.has(key)) return;
  changesInFlight.add(key);
  const days = reviewsDays;
  const answer = await sendDismissal(review, suggestion, reason).finally(() => changesInFlight.delete(key));
  if (reviewsDays !== days) {
    // The range changed while the request ran. The server has the change, and the new
    // range's data was read after it or does not hold this review, so merging would
    // count it twice or count a review outside the range.
  } else if (answer.error) {
    reviewActionError = `Could not ${reason ? 'dismiss' : 'reopen'} "${suggestionName(suggestion)}": ${answer.error}`;
  } else {
    reviewActionError = null;
    const changed = { ...suggestion, dismissedAt: answer.dismissedAt, reason: answer.reason };
    const delta = (changed.reason ? 1 : 0) - (suggestion.reason ? 1 : 0);
    holdReviews({
      ...lastReviews,
      reviews: upsertSuggestion(lastReviews.reviews, review, changed, { order: byEnd, insert: !changed.reason }),
      closedCount: lastReviews.closedCount + delta,
    });
    updateClosed(review, changed);
    reviewMutations++;
    reviewFocusKey = focusKey;
  }
  redraw();
}

// Open suggestions with their three buttons. A suggestion closed since the panel
// loaded stays as one line, "Marked done" with Undo, until the next load.
function suggestionList(r) {
  return el('ul', { class: 'review-suggestions' }, r.suggestions.map((s) => {
    const key = `${r.sessionId}:${s.idx}`;
    if (s.dismissedAt != null) {
      return el('li', { class: 'review-closed-line' }, [
        el('span', { class: 'review-kind', text: kindName(s) }),
        el('span', { class: 'review-dismissal', text: dismissalText(s) }),
        el('span', { class: 'review-actions' }, [
          iconButton('undo', `undo:${key}`, `Undo: ${suggestionName(s)}`, TIP_UNDO, () => changeSuggestion(r, s, null, `done:${key}`)),
        ]),
      ]);
    }
    return el('li', {}, [
      el('span', { class: 'review-kind', text: kindName(s) }),
      el('span', { class: 'review-text', text: s.text }),
      el('span', { class: 'review-actions' }, dismissButtons(r, s, (reason) => changeSuggestion(r, s, reason, `undo:${key}`))),
    ]);
  }));
}

function openItem(r, now) {
  const head = el('div', { class: 'review-head' }, [
    ...(r.title ? [el('span', { class: 'session-title', title: r.title, text: r.title })] : []),
    contextLine(r, ` · ended ${reviewTime(r.endedAt ?? r.reviewedAt, now)}`),
  ]);
  const top = [head];
  const prompt = reviewPrompt(r);
  if (prompt) {
    const button = el('button', { type: 'button', class: 'refresh-btn', text: reviewCopyResults.get(r.sessionId) || 'Copy prompt', 'data-review-focus': `copy:${r.sessionId}` });
    button.addEventListener('click', () => copyReviewPrompt(r.sessionId, prompt));
    top.push(withFocusTooltip(withTooltip(button, TIP_COPY), TIP_COPY));
  }
  return el('li', { class: 'review' }, [el('div', { class: 'review-top' }, top), suggestionList(r)]);
}

// Called by main.mjs with each loaded payload, and again with the same payload on a
// redraw. Shown on the Analysis tab only. Hidden when the request failed or the
// range has no open and no closed suggestion. A server error shows its text.
export function renderReviews(data) {
  if (!data || data.error || !heldReviews.has(data)) holdReviews(data);
  redraw();
}

function redraw() {
  const data = lastReviews;
  // The key holds every input of the draw, so each action redraws from its own call.
  reviewsGuard.draw(
    [data, reviewsDays, reviewMutations, reviewActionError, showAllReviews, closedVersion()],
    () => drawReviews(data)
  );
}

function drawReviews(data) {
  const panel = document.getElementById('reviewsPanel');
  const status = document.getElementById('reviewsStatus');
  const list = document.getElementById('reviewsList');
  const note = document.getElementById('reviewsNote');
  if (data && data.error) {
    panel.hidden = false;
    status.hidden = false;
    status.textContent = `Could not read session reviews: ${data.error}`;
    list.replaceChildren();
    document.getElementById('reviewsMore').replaceChildren();
    drawClosed({ closedCount: null });
    note.textContent = '';
    return;
  }
  panel.hidden = !data || (!data.reviews.length && !data.closedCount);
  if (panel.hidden) return;

  const active = document.activeElement;
  const activeKey = active && panel.contains(active) ? active.dataset.reviewFocus : null;
  status.hidden = !reviewActionError;
  status.textContent = reviewActionError || '';

  const now = Date.now();
  list.replaceChildren(...(data.reviews.length
    ? visibleRows(data.reviews, REVIEWS_LIMIT, showAllReviews).map((r) => openItem(r, now))
    : [el('li', { class: 'review review-empty', text: `No open suggestions ${rangePhrase(reviewsDays)}` })]));
  const more = showAllButton(data.reviews.length, REVIEWS_LIMIT, showAllReviews, () => {
    showAllReviews = !showAllReviews;
    redraw();
    refocusShowAll('reviewsMore');
  });
  keepShowAllFocus('reviewsMore', () => document.getElementById('reviewsMore').replaceChildren(...(more ? [more] : [])));
  const closedFocus = drawClosed({ closedCount: data.closedCount, now, onChange: changeSuggestion, redraw });

  const focusKey = closedFocus || reviewFocusKey || activeKey;
  reviewFocusKey = null;
  if (focusKey) [...panel.querySelectorAll('[data-review-focus]')].find((n) => n.dataset.reviewFocus === focusKey)?.focus({ preventScroll: true });

  const withOpen = countWithOpen(data.reviews);
  note.textContent = `${withOpen} ${withOpen === 1 ? 'review' : 'reviews'} with open suggestions · ${rangeShort(reviewsDays)}`;
}
