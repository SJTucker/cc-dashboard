// Pure text formatting for the High scores boards. It touches no DOM, so the
// tests run it under Node.
import { BOARDS } from './boards.mjs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// 'OCT 15', or "OCT 15 '25" when the date is outside thisYear. It reads the
// parts of the 'YYYY-MM-DD' string directly, because new Date() would parse it as
// UTC and could shift the day.
function dayLabel(date, thisYear) {
  const [y, m, d] = date.split('-');
  const text = `${MONTHS[Number(m) - 1]} ${d}`;
  return Number(y) === thisYear ? text : `${text} '${y.slice(2)}`;
}

// A whole number with en-US thousands separators, so the output does not depend
// on the machine's locale.
function grouped(n) {
  return Math.round(n).toLocaleString('en-US');
}

// A turn's length: '47m 12s', '1h 03m' from 60 minutes, or '12s' under a minute.
function turnText(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// The score of one entry as the board shows it.
function scoreText(key, entry) {
  const n = entry.score;
  if (key === 'cost' || key === 'session') return `$${n.toFixed(2)}`;
  if (key === 'linesAdded') return `+${grouped(n)}`;
  if (key === 'linesRemoved') return `−${grouped(n)}`;
  if (key === 'turn') return turnText(n);
  if (key === 'streak') return `${n} ${n === 1 ? 'DAY' : 'DAYS'}`;
  return grouped(n);
}

// The DAY column of one entry: TODAY for a today entry on a day board, a
// start→end range for a streak, otherwise the entry's date.
function dayText(key, entry, thisYear) {
  const board = BOARDS.find((b) => b.key === key);
  if (board.kind === 'day' && entry.today) return 'TODAY';
  if (board.kind === 'streak' && entry.end) return `${dayLabel(entry.date, thisYear)}→${dayLabel(entry.end, thisYear)}`;
  return dayLabel(entry.date, thisYear);
}

// One display row per entry of a board, ranked from '01'. Only the first place
// gets the crown and `first`.
function boardRows(key, entries, thisYear) {
  return entries.map((e, i) => ({
    rank: String(i + 1).padStart(2, '0'),
    crown: i === 0,
    day: dayText(key, e, thisYear),
    title: e.title ?? null,
    score: scoreText(key, e),
    first: i === 0,
    today: !!e.today,
  }));
}

// One hall-of-fame row per board in BOARDS order, built from each board's first
// entry. A board with no entry gets '—' so the hall always lists every board.
function hallRows(boards, thisYear) {
  return BOARDS.map(({ key, hall }) => {
    const e = boards[key]?.[0];
    if (!e) return { label: hall, day: '—', score: '—', first: true, today: false };
    return { label: hall, day: dayText(key, e, thisYear), score: scoreText(key, e), first: true, today: !!e.today };
  });
}

export { dayLabel, scoreText, boardRows, hallRows };
