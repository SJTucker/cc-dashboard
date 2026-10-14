// Text for the prices note and for the lines Check prices prints. Pure: no DOM,
// no state, so node can test it.
import { DEFAULT_CACHE_READ_MULT } from './constants.mjs';

const readMult = (row) => (row.cacheReadMult != null ? row.cacheReadMult : DEFAULT_CACHE_READ_MULT);
const shortName = (row) => (row.name || row.match).replace(/^Claude /, '');
const fastText = (row) => (row.fast ? `$${row.fast.input} / $${row.fast.output}` : 'none');
const longText = (row) => (row.longPrompt
  ? `over ${row.longPrompt.over.toLocaleString('en-US')} tokens $${row.longPrompt.input} / $${row.longPrompt.output}`
  : 'none');

// What differs between the old and new row of one model, as short phrases.
export function rateChanges(before, after) {
  const parts = [];
  if (before.input !== after.input) parts.push(`input $${before.input} → $${after.input}`);
  if (before.output !== after.output) parts.push(`output $${before.output} → $${after.output}`);
  if (readMult(before) !== readMult(after)) parts.push(`cache read ${readMult(before)}x → ${readMult(after)}x`);
  if (fastText(before) !== fastText(after)) parts.push(`fast ${fastText(before)} → ${fastText(after)}`);
  if (longText(before) !== longText(after)) parts.push(`long prompt ${longText(before)} → ${longText(after)}`);
  return parts.join(', ');
}

// One line per model after a check, then the models the page listed that the
// dashboard cannot price. "No changes" comes first when no price moved.
export function checkLines(result) {
  const lines = [
    ...result.added.map((row) => `Added ${shortName(row)}, all dates`),
    ...result.changed.map((c) => `${shortName(c.after)}: ${rateChanges(c.before, c.after)}, from ${result.effectiveFrom}`),
    ...result.skipped.map((s) => `Skipped: ${s.name} (${s.reason})`),
  ];
  if (!result.added.length && !result.changed.length) lines.unshift('No changes');
  return lines;
}

// The line under the Cost by model table, from the GET /api/prices response.
export function sourceLine(source) {
  let text = source.kind === 'built-in'
    ? `Prices: built-in, checked ${source.lastCheck || source.date}`
    : `Prices: from Anthropic's pricing page, effective ${source.date}${source.lastCheck ? `, checked ${source.lastCheck}` : ''}`;
  if (source.lastError) text += ` · last check failed: ${source.lastError}`;
  // With applied snapshots in use, the file was good at an earlier read (lib/price-store.js).
  if (source.error) text += ` · prices.json ${source.snapshots ? 'unreadable, last good prices kept' : 'ignored'}: ${source.error}`;
  return text;
}
