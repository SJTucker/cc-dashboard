'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/format.mjs');

test('formatCost shows a dash for no value and <$0.01 under a cent', async () => {
  const { formatCost } = await load();
  assert.equal(formatCost(null), '—');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(1234.5), '$1,234.50');
});

test('formatTokens switches unit at each thousand', async () => {
  const { formatTokens } = await load();
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_500_000), '2.50M');
  assert.equal(formatTokens(3e9), '3.00B');
});

test('formatPercent and formatDuration', async () => {
  const { formatPercent, formatDuration } = await load();
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(0.1234), '12.3%');
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

test('formatAgo counts minutes up to an hour', async () => {
  const { formatAgo } = await load();
  const now = Date.UTC(2026, 9, 9, 12, 0);
  assert.equal(formatAgo(now - 30_000, now), 'just now');
  assert.equal(formatAgo(now - 5 * 60_000, now), '5m ago');
});

test('localDateStr is the local calendar date', async () => {
  const { localDateStr } = await load();
  assert.equal(localDateStr(new Date(2026, 9, 9, 23, 30)), '2026-10-09');
  assert.equal(localDateStr(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
});

test('costPerDay divides complete days by their calendar span and leaves out today', async () => {
  const { costPerDay } = await load();
  const daily = [
    { date: '2026-10-01', cost: 2 },
    { date: '2026-10-03', cost: 4 },
    { date: '2026-10-09', cost: 100 },
  ];
  assert.equal(costPerDay(daily, '2026-10-09'), 2);
  assert.equal(costPerDay([{ date: '2026-10-09', cost: 5 }], '2026-10-09'), null);
  assert.equal(costPerDay([{ date: '2026-10-09T14', cost: 5 }], '2026-10-10'), null);
});

test('shortDate and fullDate read day and hour bucket keys', async () => {
  const { shortDate, fullDate } = await load();
  assert.equal(shortDate('2026-09-21'), '9/21');
  assert.equal(shortDate('2026-09-21T14'), '14:00');
  assert.equal(fullDate('2026-09-21'), '2026-09-21');
  assert.equal(fullDate('2026-09-21T14'), '2026-09-21 14:00');
});

test('shortModel keeps the family and version and drops a date suffix', async () => {
  const { shortModel } = await load();
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5-5');
  assert.equal(shortModel('claude-sonnet-5'), 'sonnet-5');
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku-4-5');
  assert.equal(shortModel('claude-sonnet-4-6-20260115'), 'sonnet-4-6');
  assert.equal(shortModel('claude-sonnet-4.5'), 'sonnet-4.5');
  assert.equal(shortModel('claude-opus-5-5[1m]'), 'opus-5-5');
  // An id that does not start claude-<family>-<digit> is shown whole.
  assert.equal(shortModel('claude-3-5-sonnet-20240620'), 'claude-3-5-sonnet-20240620');
  assert.equal(shortModel('gpt-x'), 'gpt-x');
});

test('axisTokens drops trailing zero decimals and axisCost fits the gutter', async () => {
  const { axisTokens, axisCost } = await load();
  assert.equal(axisTokens(200_000_000), '200M');
  assert.equal(axisTokens(1500), '1.5k');
  assert.equal(axisCost(1.5), '$1.50');
  assert.equal(axisCost(2), '$2');
  assert.equal(axisCost(12.4), '$12');
  assert.equal(axisCost(1500), '$1.5k');
});

test('escapeHtml escapes all five markup characters', async () => {
  const { escapeHtml } = await load();
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(escapeHtml(42), '42');
});

test('formatTokens keeps the unit for negative values', async () => {
  const { formatTokens, axisTokens } = await load();
  assert.equal(formatTokens(-6188), '-6.2k');
  assert.equal(formatTokens(-999), '-999');
  assert.equal(formatTokens(-2_500_000), '-2.50M');
  assert.equal(axisTokens(-5000), '-5k');
});

test('thinkingShare divides thinking by the output of the calls that report it', async () => {
  const { thinkingShare } = await load();
  assert.equal(thinkingShare({ thinking: 40, thinkingOutput: 160 }), 0.25);
  assert.equal(thinkingShare({ thinking: 0, thinkingOutput: 0 }), null);
  assert.equal(thinkingShare({}), null);
});

test('thinkingNote gives the thinking cost and the share of calls that report it', async () => {
  const { thinkingNote } = await load();
  assert.equal(thinkingNote({ thinkingCost: 412.5, thinkingCalls: 58, apiCalls: 100 }), '$412.50 at output rates · 58% of calls report it');
  assert.equal(thinkingNote({ thinkingCost: 0, thinkingCalls: 3, apiCalls: 4 }), '75% of calls report it');
  assert.equal(thinkingNote({ thinkingCost: 0, thinkingCalls: 0, apiCalls: 9 }), '0% of calls report it');
  assert.equal(thinkingNote({ thinkingCost: 0, thinkingCalls: 0, apiCalls: 0 }), '');
});

test('modelLabel names a model the way people say it', async () => {
  const { modelLabel } = await load();
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('claude-sonnet-4.5'), 'Sonnet 4.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('gpt-x'), 'gpt-x');
});

test('familyLabel capitalises a family key', async () => {
  const { familyLabel } = await load();
  assert.equal(familyLabel('opus'), 'Opus');
  assert.equal(familyLabel('other'), 'Other');
  assert.equal(familyLabel(''), '');
});

test('unpricedNote names the unpriced token count and is empty when none', async () => {
  const { unpricedNote } = await load();
  assert.equal(unpricedNote({ unpricedTokens: 1500 }), '1.5k tokens from unrecognized models not priced');
  assert.equal(unpricedNote({ unpricedTokens: 0 }), '');
  assert.equal(unpricedNote({}), '');
});
