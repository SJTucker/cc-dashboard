'use strict';

const { localDateStr } = require('./dates');

// The server's aggregates, one per range and bucket, reused while the row store's
// generation and the local date are unchanged. The date is part of the check
// because a range's start moves at midnight with no transcript changing. Only the
// latest aggregate per range is kept. The all-time aggregate measured 7.2 MB on
// 2026-10-08 (docs/ideas/row-store-growth.md). A numeric range (7, 30, 90) is
// stored without `efficiency`, the per-call records that only /api/changes (all
// time) and /api/sessions/live (Today) read.
function createScanMemo({ getRowStore, aggregate, getProjectsDir }) {
  const memo = new Map(); // `${days}:${bucket}` -> { generation, day, data }

  // The row store skips a session file it cannot read, which lowers that range's
  // totals. The terminal gets one warning per range each time the count of skipped
  // files changes, so the 5s live poll does not repeat it.
  const unreadableByRange = new Map();
  function warnUnreadable(range, data) {
    const n = data.meta.unreadableFiles || 0;
    if (n === (unreadableByRange.get(range) || 0)) return data;
    unreadableByRange.set(range, n);
    if (n) {
      const files = n === 1 ? '1 session file could not be read and was' : `${n} session files could not be read and were`;
      console.warn(`[scan] ${files} left out of the ${range} totals.`);
    }
    return data;
  }

  // Every route that needs a range goes through here. The row store re-reads only
  // the transcripts that changed, so a call with nothing new costs one stat pass.
  // Concurrent calls share that pass.
  async function scan(days, bucket = 'day') {
    const rowStore = getRowStore();
    await rowStore.refresh();
    const key = `${days}:${bucket}`;
    const day = localDateStr(new Date());
    const hit = memo.get(key);
    if (hit && hit.generation === rowStore.generation && hit.day === day) return hit.data;
    const range = days == null ? 'all-time' : days === 'today' ? 'Today' : `${days}-day`;
    const data = warnUnreadable(
      range,
      aggregate(rowStore.entries().map((e) => e.rows), { days, bucket, projectsDir: getProjectsDir() }),
    );
    if (typeof days === 'number') delete data.efficiency;
    memo.set(key, { generation: rowStore.generation, day, data });
    return data;
  }

  // Costs are computed when rows are aggregated, so a price change clears the memo.
  // The stored rows hold token counts only and need no re-read.
  function clear() {
    memo.clear();
  }

  return { scan, clear };
}

module.exports = { createScanMemo };
