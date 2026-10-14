// The closed half of the Session reviews panel: suggestions marked done, duplicate
// or not useful, or expired 14 days after their review, in the range picker's range.
// Hidden until "Show closed (n)". Pages of REVIEWS_CLOSED_PAGE reviews load from
// /api/reviews/closed, newest first, while the server returns a next cursor.
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { REVIEWS_CLOSED_PAGE } from '../constants.mjs';
import { reasonLabel, byCursor, upsertSuggestion } from '../reviews.mjs';
import { kindName, reviewTime, iconButton, TIP_UNDO, suggestionName, dismissButtons } from './review-ui.mjs';

const view = { shown: false, days: '7', reviews: [], next: null, loaded: false, loading: false, error: null, focusKey: null };
// Counts changes to view, so the panel's draw guard redraws after each one.
let version = 0;
// Counts resets. A page that arrives after a reset belongs to the old range and is
// dropped.
let generation = 0;
export const closedVersion = () => version;

// A new load of the panel: hides the list and drops its pages.
export function resetClosed(days) {
  Object.assign(view, { shown: false, days, reviews: [], next: null, loaded: false, loading: false, error: null, focusKey: null });
  generation++;
  version++;
}

// Puts a suggestion changed in either list into the loaded pages. Before the first
// page loads there is nothing to change, because that page will carry the change.
export function updateClosed(review, suggestion) {
  if (!view.loaded) return;
  view.reviews = upsertSuggestion(view.reviews, review, suggestion, { order: byCursor, insert: suggestion.reason != null, hasMore: view.next != null });
  version++;
}

// Fetches the next page, or the first one. A failure keeps the loaded pages and
// shows the reason with Try again. focusNew moves focus to the first new review.
async function loadPage(redraw, focusNew) {
  if (view.loading) return;
  const gen = generation;
  view.loading = true;
  view.error = null;
  version++;
  redraw();
  const params = new URLSearchParams({ days: view.days, limit: String(REVIEWS_CLOSED_PAGE) });
  if (view.loaded && view.next) params.set('before', view.next);
  const body = await getJson(`/api/reviews/closed?${params}`);
  if (gen !== generation) return;
  view.loading = false;
  if (body.error) {
    view.error = body.error;
  } else {
    // A review this page brings may already be in the list from a local change. The
    // server's copy replaces it.
    const ids = new Set(body.reviews.map((r) => r.sessionId));
    view.reviews = [...view.reviews.filter((r) => !ids.has(r.sessionId)), ...body.reviews].sort(byCursor);
    view.next = body.next;
    view.loaded = true;
    if (focusNew && body.reviews.length) view.focusKey = `closed-review:${body.reviews[0].sessionId}`;
  }
  version++;
  redraw();
}

function toggle(redraw) {
  view.shown = !view.shown;
  version++;
  if (view.shown && !view.loaded) loadPage(redraw, false);
  else redraw();
}

// One suggestion in the closed list, dimmed, with its reason as a word. Undo reopens
// it, and the line then reads "Reopened" until the next load. An expired suggestion
// has no Undo, because the next review run would expire it again. It has the three
// dismiss buttons instead, to give it a reason.
function closedRow(r, s, onChange) {
  const key = `${r.sessionId}:${s.idx}`;
  let label = 'Reopened';
  let actions = [];
  if (s.reason === 'expired') {
    label = reasonLabel(s);
    actions = dismissButtons(r, s, (reason) => onChange(r, s, reason, `closed-undo:${key}`), 'closed-');
  } else if (s.reason != null) {
    label = reasonLabel(s);
    actions = [iconButton('undo', `closed-undo:${key}`, `Reopen: ${suggestionName(s)}`, TIP_UNDO, () => onChange(r, s, null, 'closed-toggle'))];
  }
  return el('li', {}, [
    el('span', { class: 'review-kind', text: kindName(s) }),
    el('span', { class: 'review-text' }, [document.createTextNode(`${s.text} `), el('span', { class: 'review-reason', text: label })]),
    el('span', { class: 'review-actions' }, actions),
  ]);
}

function closedItem(r, now, onChange) {
  const name = r.title || r.project || r.sessionId;
  const head = el('p', {
    class: 'review-head', tabindex: '-1', 'data-review-focus': `closed-review:${r.sessionId}`,
    text: `${name} · ended ${reviewTime(r.endedAt ?? r.reviewedAt, now)}`,
  });
  return el('li', { class: 'review' }, [head, el('ul', { class: 'review-dismissed' }, r.suggestions.map((s) => closedRow(r, s, onChange)))]);
}

function controlButton(text, focusKey, onClick, { busy = false } = {}) {
  const button = el('button', { type: 'button', class: 'show-all', text, 'data-review-focus': focusKey });
  // aria-disabled, not disabled, so a focused button keeps focus while it loads.
  if (busy) button.setAttribute('aria-disabled', 'true');
  button.addEventListener('click', () => { if (!busy) onClick(); });
  return button;
}

// Draws the toggle into #reviewsClosedToggle and the list into #reviewsClosed.
// closedCount null, or 0 while the list is hidden, draws nothing. Returns the focus
// key a page load asked for, for the panel to focus after its own draw, or null.
export function drawClosed({ closedCount, now, onChange, redraw }) {
  const toggleBox = document.getElementById('reviewsClosedToggle');
  const section = document.getElementById('reviewsClosed');
  if (closedCount == null || (!closedCount && !view.shown)) {
    toggleBox.replaceChildren();
    section.hidden = true;
    return null;
  }
  const toggleButton = controlButton(view.shown ? 'Hide closed ▴' : `Show closed (${closedCount}) ▾`, 'closed-toggle', () => toggle(redraw));
  toggleButton.setAttribute('aria-expanded', String(view.shown));
  toggleButton.setAttribute('aria-controls', 'reviewsClosed');
  toggleBox.replaceChildren(toggleButton);
  section.hidden = !view.shown;
  if (!view.shown) return null;

  document.getElementById('reviewsClosedList').replaceChildren(...view.reviews.map((r) => closedItem(r, now, onChange)));
  const status = document.getElementById('reviewsClosedStatus');
  const empty = view.loaded && !view.reviews.length;
  status.hidden = !view.error && !empty;
  status.textContent = view.error ? `Could not load closed suggestions: ${view.error}` : empty ? 'No closed suggestions.' : '';

  const controls = [];
  if (view.error) controls.push(controlButton('Try again', 'closed-more', () => loadPage(redraw, view.loaded)));
  else if (view.loading) controls.push(controlButton('Loading…', 'closed-more', () => {}, { busy: true }));
  else if (view.next) controls.push(controlButton(`Show ${REVIEWS_CLOSED_PAGE} more`, 'closed-more', () => loadPage(redraw, true)));
  controls.push(controlButton('Hide closed ▴', 'closed-hide', () => toggle(redraw)));
  document.getElementById('reviewsClosedMore').replaceChildren(...controls);

  const focusKey = view.focusKey;
  view.focusKey = null;
  return focusKey;
}
