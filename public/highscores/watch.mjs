// Detects the moment today takes first place on a record board, so the header
// animation can play. Pure functions: storage is passed in, no globals are read.
import { BOARDS } from './boards.mjs';

const KEY = 'cc-dashboard:record-fx';

// Boards that never play the animation: a running streak that is already the
// record sets a new record every day.
const NO_FX = ['streak'];

// Returns { state, play, celebrated } for one poll. `prev` is the last poll's
// { day, first } or null, `firstKeys` the boards where today now holds first
// place, `celebrated` the stored { date, boards } or null. `play` lists, in
// BOARDS order, the boards that just flipped to today-first and were not
// already celebrated today. Boards in NO_FX never play. The first poll, and a poll after the day changed,
// only record the state, so a load or a midnight rollover never plays.
export function step(prev, firstKeys, todayStr, celebrated) {
  const state = { day: todayStr, first: [...firstKeys] };
  const done = celebrated && celebrated.date === todayStr ? celebrated.boards : [];
  if (!prev || prev.day !== todayStr) return { state, play: [], celebrated: celebrated ?? null };
  const play = BOARDS.map((b) => b.key).filter((k) => !NO_FX.includes(k) && firstKeys.has(k) && !prev.first.includes(k) && !done.includes(k));
  return { state, play, celebrated: { date: todayStr, boards: [...done, ...play] } };
}

// Returns the keys, in BOARDS order, of the boards whose first place was set on
// the latest date, so the header icon can replay the most recent record. An
// entry counts as set on `todayStr` when it has today: true (a session that
// started yesterday can set a record today), else on its own date. Boards in
// NO_FX and empty or missing boards are left out. No boards gives [].
export function latestRecords(boards, todayStr) {
  const dated = BOARDS.filter((b) => !NO_FX.includes(b.key) && boards[b.key]?.[0]).map((b) => {
    const first = boards[b.key][0];
    return { key: b.key, set: first.today ? todayStr : first.date };
  });
  const latest = dated.reduce((m, d) => (d.set > m ? d.set : m), '');
  return dated.filter((d) => d.set === latest).map((d) => d.key);
}

// Reads the celebrated record from `storage`, or null when it is missing,
// malformed or unreadable (a private window can throw).
export function readCelebrated(storage) {
  try {
    const v = JSON.parse(storage.getItem(KEY));
    if (v && typeof v.date === 'string' && Array.isArray(v.boards) && v.boards.every((b) => typeof b === 'string')) return v;
  } catch { /* unreadable storage or bad JSON */ }
  return null;
}

// Stores `value` under the record key. A storage that throws loses the write
// and the animation may repeat after a reload, which is acceptable.
export function writeCelebrated(storage, value) {
  try {
    storage.setItem(KEY, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}
