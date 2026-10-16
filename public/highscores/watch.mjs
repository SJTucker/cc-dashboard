// Detects the moment today takes first place on a record board, so the header
// animation can play. Pure functions: storage is passed in, no globals are read.
import { BOARDS } from './boards.mjs';

const KEY = 'cc-dashboard:record-fx';

// Returns { state, play, celebrated } for one poll. `prev` is the last poll's
// { day, first } or null, `firstKeys` the boards where today now holds first
// place, `celebrated` the stored { date, boards } or null. `play` lists, in
// BOARDS order, the boards that just flipped to today-first and were not
// already celebrated today. The first poll, and a poll after the day changed,
// only record the state, so a load or a midnight rollover never plays.
export function step(prev, firstKeys, todayStr, celebrated) {
  const state = { day: todayStr, first: [...firstKeys] };
  const done = celebrated && celebrated.date === todayStr ? celebrated.boards : [];
  if (!prev || prev.day !== todayStr) return { state, play: [], celebrated: celebrated ?? null };
  const play = BOARDS.map((b) => b.key).filter((k) => firstKeys.has(k) && !prev.first.includes(k) && !done.includes(k));
  return { state, play, celebrated: { date: todayStr, boards: [...done, ...play] } };
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
