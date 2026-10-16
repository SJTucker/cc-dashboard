// Shared by the browser and the server, so both rank the same way: the High scores
// panel imports it, and server.js require()s it. It touches no DOM at import.

const BOARD_SIZE = 10;

// The boards in display order. `hall` is the short label used in the hall of fame;
// `kind` says how a board's entries are built from live values in mergeToday.
const BOARDS = [
  { key: 'tokens', title: 'TOKENS IN ONE DAY', hall: 'TOKENS', kind: 'day' },
  { key: 'cost', title: 'COST IN ONE DAY', hall: 'COST', kind: 'day' },
  { key: 'prompts', title: 'PROMPTS IN ONE DAY', hall: 'PROMPTS', kind: 'day' },
  { key: 'sessions', title: 'SESSIONS IN ONE DAY', hall: 'SESSIONS', kind: 'day' },
  { key: 'linesAdded', title: 'LINES ADDED IN ONE DAY', hall: 'LINES ADDED', kind: 'day' },
  { key: 'linesRemoved', title: 'LINES DELETED IN ONE DAY', hall: 'LINES DELETED', kind: 'day' },
  { key: 'session', title: 'BIGGEST SESSION', hall: 'BIGGEST SESSION', kind: 'session' },
  { key: 'turn', title: 'LONGEST TURN', hall: 'LONGEST TURN', kind: 'turn' },
  { key: 'streak', title: 'LONGEST STREAK', hall: 'STREAK', kind: 'streak' },
];

// Local calendar date (YYYY-MM-DD) of a millisecond timestamp. Local, not UTC,
// because "a day" on the dashboard is the user's own day.
function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The top BOARD_SIZE entries: scores of 0 or less are dropped, higher scores come
// first, and a tie goes to the entry with the earlier `at`. Returns a new array.
function rankEntries(entries) {
  return entries
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, BOARD_SIZE);
}

// The boards with today's live values merged in, each re-ranked and today's
// entries marked `today: true`. Returns null when the payload was built on another
// date (a page left open past midnight), because yesterday's entries are missing
// from it and today could be crowned falsely. With no live data the payload's
// boards come back unchanged. Nothing in `payload` is mutated: the panel merges
// into the same payload on every poll.
function mergeToday(payload, live, todayStr) {
  if (payload.date !== todayStr) return null;
  if (!live) return payload.boards;
  const midnight = Date.parse(todayStr + 'T00:00:00');
  const out = {};
  for (const { key, kind } of BOARDS) {
    let list = payload.boards[key] || [];
    const added = [];
    if (kind === 'day') {
      added.push({ id: todayStr, date: todayStr, at: midnight, score: live[key] });
    } else if (kind === 'session') {
      const liveIds = new Set(live.sessionCosts.map((s) => s.sessionId));
      list = list.filter((x) => !liveIds.has(x.id));
      for (const s of live.sessionCosts) {
        const carry = payload.carry[s.sessionId];
        const at = carry?.at ?? s.at;
        added.push({ id: s.sessionId, date: localDate(at), at, score: s.cost + (carry?.cost ?? 0), title: s.title });
      }
    } else if (kind === 'turn') {
      for (const t of live.turns) {
        added.push({ id: t.sessionId + ':' + t.t, date: todayStr, at: t.t, score: t.durationMs, title: t.title });
      }
    } else if (kind === 'streak' && live.tokens > 0) {
      const run = payload.currentRun;
      const start = run ? run.start : todayStr;
      list = list.filter((x) => x.id !== start);
      added.push({ id: start, date: start, end: todayStr, at: Date.parse(start + 'T00:00:00'), score: run ? run.days + 1 : 1 });
    }
    out[key] = rankEntries([...list, ...added.map((x) => ({ ...x, today: true }))]);
  }
  return out;
}

// The keys of boards where today holds first place and at least one earlier entry
// is on the board, so a first-ever entry is not announced as a record.
function todayFirstKeys(merged) {
  const keys = new Set();
  for (const [key, list] of Object.entries(merged)) {
    if (list[0]?.today && list.some((x) => !x.today)) keys.add(key);
  }
  return keys;
}

export { BOARDS, BOARD_SIZE, rankEntries, mergeToday, todayFirstKeys, localDate };
