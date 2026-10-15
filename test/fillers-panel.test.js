'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/panels/fillers.mjs');

test('fillerCells shows a path as its basename and keeps the path for the tooltip', async () => {
  const { fillerCells } = await load();
  const cells = fillerCells({ tool: 'Read', group: '/r/lib/extract.js', calls: 1200, sessions: 40, chars: 2_500_000, median: 4100, max: 125_000, rereads: 300 });
  assert.deepStrictEqual(cells, {
    group: 'extract.js', groupTitle: '/r/lib/extract.js', tool: 'Read', calls: '1,200', sessions: '40',
    chars: '2.50M', median: '4.1k', max: '125.0k', rereads: '300',
  });
});

test('fillerCells shows a dash for re-reads on a tool other than Read', async () => {
  const { fillerCells } = await load();
  const cells = fillerCells({ tool: 'Bash', group: 'sed -n', calls: 2, sessions: 1, chars: 10, median: 5, max: 6, rereads: 0 });
  assert.strictEqual(cells.group, 'sed -n');
  assert.strictEqual(cells.rereads, '–');
});

test('turnCells formats the duration, calls and cost, and falls back to the session id', async () => {
  const { turnCells } = await load();
  const cells = turnCells({ t: 0, start: Date.UTC(2026, 9, 14, 9, 5), sessionId: 'abcdef123456', durationMs: 3_725_000, calls: 3, cost: 0.5, title: null });
  assert.strictEqual(cells.title, 'abcdef12');
  assert.strictEqual(cells.duration, '1h 2m');
  assert.strictEqual(cells.calls, '3');
  assert.strictEqual(cells.cost, '$0.50');
  assert.ok(cells.started.length > 0);
});
