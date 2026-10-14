// Pieces the Session reviews panel's open list (reviews.mjs) and closed list
// (reviews-closed.mjs) share: kind names, times, icon buttons and the dismiss request.
import { el, svgEl, withTooltip, withFocusTooltip } from '../dom.mjs';
import { formatAgo, localDateStr } from '../format.mjs';

const REVIEW_KINDS = {
  'claude-md': 'CLAUDE.md',
  'skill-or-hook': 'Skill or hook',
  'token-waste': 'Token waste',
  workflow: 'Workflow',
};
export const kindName = (s) => REVIEW_KINDS[s.kind] || s.kind;

// "5m ago" or a time for today, a weekday with a time for the last 6 days, and a
// date with a time before that, which the 30d, 90d and All ranges reach.
export function reviewTime(ms, now) {
  if (localDateStr(new Date(ms)) === localDateStr(new Date(now))) return formatAgo(ms, now);
  const older = now - ms > 6 * 24 * 60 * 60 * 1000;
  const parts = older ? { month: 'short', day: 'numeric' } : { weekday: 'short' };
  return new Date(ms).toLocaleString([], { ...parts, hour: '2-digit', minute: '2-digit' });
}

// Lucide icon paths, drawn in a 24 x 24 box.
const ICONS = {
  check: [{ d: 'M20 6 9 17l-5-5' }],
  x: [{ d: 'M18 6 6 18' }, { d: 'm6 6 12 12' }],
  undo: [{ d: 'M9 14 4 9l5-5' }, { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }],
  copy: [{ d: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z' }, { d: 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2' }],
};

// The tooltip text is fixed, so it needs no escaping. A <br> breaks a long line,
// because .tooltip does not wrap.
export const reviewTip = (title, ...lines) => `<b>${title}</b><br>${lines.join('<br>')}`;

// A square icon button. The aria-label names the suggestion, which the icon alone
// cannot, so the tooltip is for sighted users and adds nothing for a screen reader.
export function iconButton(icon, focusKey, ariaLabel, tip, onClick) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const attrs of ICONS[icon]) svg.appendChild(svgEl('path', attrs));
  const button = el('button', { type: 'button', class: 'review-icon', 'data-review-focus': focusKey, 'aria-label': ariaLabel }, [svg]);
  button.addEventListener('click', onClick);
  return withFocusTooltip(withTooltip(button, tip), tip);
}

const TIP_DONE = reviewTip('Done', 'I acted on this. Moves it to the closed list.');
const TIP_DUPLICATE = reviewTip('Duplicate', 'Useful, but a rule, skill or earlier suggestion already covers it.');
const TIP_NOT_USEFUL = reviewTip('Not useful', 'Hide it and record that Haiku got it wrong.');
export const TIP_UNDO = reviewTip('Undo', 'Put this suggestion back in the open list.');

export const suggestionName = (s) => `${kindName(s)}: ${s.text.length > 80 ? `${s.text.slice(0, 79)}…` : s.text}`;

// The Done, Duplicate and Not useful buttons of one suggestion. onChange(reason) runs
// on a click. keyPrefix keeps the closed list's focus keys apart from the open list's.
export function dismissButtons(review, s, onChange, keyPrefix = '') {
  const key = `${review.sessionId}:${s.idx}`;
  return [
    iconButton('check', `${keyPrefix}done:${key}`, `Mark done: ${suggestionName(s)}`, TIP_DONE, () => onChange('done')),
    iconButton('copy', `${keyPrefix}duplicate:${key}`, `Dismiss as duplicate: ${suggestionName(s)}`, TIP_DUPLICATE, () => onChange('duplicate')),
    iconButton('x', `${keyPrefix}notuseful:${key}`, `Dismiss as not useful: ${suggestionName(s)}`, TIP_NOT_USEFUL, () => onChange('not_useful')),
  ];
}

// Sends a dismissal (POST) or its undo (DELETE, when reason is null). Resolves to
// the server's answer, or to { error } when the request or the server failed.
export async function sendDismissal(review, suggestion, reason) {
  const url = `/api/reviews/${encodeURIComponent(review.sessionId)}/suggestions/${suggestion.idx}/dismiss`;
  const init = reason
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }
    : { method: 'DELETE' };
  const res = await fetch(url, init).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  if (res && res.ok && body && body.ok) return body;
  return { error: (body && body.error) || 'the request failed' };
}
