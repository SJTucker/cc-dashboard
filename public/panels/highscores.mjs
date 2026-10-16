// The High scores tab: a synthwave arcade screen that shows the hall of fame and
// one top 10 board per record. The boards come from /api/highscores. Today's rows
// are merged in from every today summary the sticky bar polls (onTodaySummary).
import { getJson } from '../api.mjs';
import { el } from '../dom.mjs';
import { formatCost, localDateStr } from '../format.mjs';
import { createSequence } from '../guards.mjs';
import { BOARDS, BOARD_SIZE, mergeToday, todayFirstKeys } from '../highscores/boards.mjs';
import { boardRows, hallRows, scoreText } from '../highscores/view.mjs';
import { step, latestRecords, readCelebrated, writeCelebrated } from '../highscores/watch.mjs';
import { playRecordFx, isPlaying } from '../fx/record-fx.mjs';
import { buildScene } from '../highscores/scene.mjs';

const CYCLE_MS = 6000;
const CLOCK_MS = 10_000;
// Screen 0 is the hall of fame, screens 1..9 are the boards in BOARDS order.
const SCREENS = BOARDS.length + 1;

let payload = null; // the last good /api/highscores body
let lastLive = null; // the latest todayRecords block
let lastMerged = null; // payload boards with today merged in, null when none yet or stale
let prev = null; // the last poll's { day, first } for the record animation, null until one merge
let staleRequestedFor = null; // the date a refetch was already started for
let screen = 0;
let cycleTimer = null;
let clockTimer = null;
let drawnKey = null; // the signature of what the table shows, so a poll with no change rebuilds nothing
let built = false;
const loads = createSequence();
const nodes = {};

const pad = (n) => String(n).padStart(2, '0');

// Whether the tab is on screen: its container is shown and the browser tab is not hidden.
function isVisible() {
  const tab = document.getElementById('tabHighscores');
  return !!tab && !tab.hidden && !document.hidden;
}

// Whether the user asked the browser for less motion. Re-read on each call so a
// change in the system setting applies at once.
function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// A <div class="side"> positioned by CSS, holding `lines` separated by <br>.
function sideText(cls, lines) {
  const node = el('div', { class: `side ${cls}` });
  fillLines(node, lines);
  return node;
}

// Puts each string of `lines` into `node` with a <br> between. Text only, never HTML.
function fillLines(node, lines) {
  lines.forEach((line, i) => {
    if (i) node.appendChild(document.createElement('br'));
    node.appendChild(document.createTextNode(line));
  });
}

// The corner and edge text around the board, copied from the approved mockup. The
// clock and credits nodes are kept in `nodes` for the later updates.
function buildSides() {
  const logo = el('div', { class: 'side side-tl' });
  const logoText = el('div', { class: 'logo' });
  fillLines(logoText, ['TOKEN', 'DRIFTER']);
  logo.append(logoText, el('div', { class: 'logo-k', text: 'トークン・ドリフター' }));
  fillLines(logo, ['ARCADE MODE', 'V1.0', '', '///', '', 'SHIP', 'FASTER', 'THAN', 'A', 'CACHE', 'EXPIRES.']);

  nodes.date = el('span');
  nodes.clock = el('span');
  const panel = el('div', { class: 'hs-panel' });
  fillLines(panel, [`PORT ${location.port || '80'}`, 'LOCALHOST', '']);
  panel.append(nodes.date, document.createElement('br'), nodes.clock, el('div', { class: 'bar-wrap' }, [el('div', { class: 'hs-bar' })]));
  const tr = el('div', { class: 'side side-tr' }, [panel]);
  const trList = el('div', { class: 'tr-list' });
  fillLines(trList, ['TOKENS', 'COST', 'CACHE', 'REPEAT', '>>>']);
  tr.appendChild(trList);

  nodes.credits = el('div', { class: 'side side-br' });
  return [
    logo,
    tr,
    el('div', { class: 'side vert', text: '未来へ走れ' }),
    sideText('side-bl', ['1 PROMPT TO DREAM']),
    nodes.credits,
    el('div', { class: 'side side-bc', text: 'トークンは眠らない' }),
  ];
}

// The centre column: titles, the board name between its arrows, the row of
// squares, the table and the INSERT TOKENS box.
function buildCenter() {
  nodes.prev = el('button', { type: 'button', 'aria-label': 'Previous board', text: '◀' });
  nodes.next = el('button', { type: 'button', 'aria-label': 'Next board', text: '▶' });
  nodes.name = el('span', { class: 'name', 'aria-live': 'polite' });
  nodes.dots = el('div', { class: 'dots', 'aria-hidden': 'true' });
  nodes.table = el('table', { class: 'hs' });
  return el('div', { class: 'center' }, [
    el('div', { class: 'kana', text: 'ハイスコア' }),
    el('h2', { class: 'hs-title', text: 'HIGH SCORES' }),
    el('div', { class: 'rule', text: 'LEGENDS NEVER FADE' }),
    el('div', { class: 'board' }, [nodes.prev, nodes.name, nodes.next]),
    nodes.dots,
    nodes.table,
    el('div', { class: 'press' }, [
      el('span', { text: '>>>' }),
      el('span', { class: 'box' }, [document.createTextNode('INSERT TOKENS'), el('span', { class: 'cursor', text: '_' })]),
      el('span', { text: '<<<' }),
    ]),
  ]);
}

// The boards the screen shows: today merged in when that worked, else the last
// payload's boards (stale, so no today rows), else nothing, which draws dashes.
function shownBoards() {
  return lastMerged ?? payload?.boards ?? {};
}

// One <tr> of the table from a list of cell specs ({ text, cls, crown }).
function tableRow(cells, cls) {
  const tr = el('tr', cls ? { class: cls } : {});
  for (const c of cells) {
    const td = el('td', c.cls ? { class: c.cls } : {});
    if (c.crown !== undefined) td.appendChild(el('span', { class: c.crown ? 'crown' : 'crown off', text: '♛' }));
    td.appendChild(document.createTextNode(c.text));
    tr.appendChild(td);
  }
  return tr;
}

// A <tr> of column headers.
function headerRow(names) {
  const tr = el('tr');
  names.forEach((name, i) => {
    const cls = i === names.length - 1 ? 'n' : name === 'TITLE' ? 'ttl' : '';
    tr.appendChild(el('th', cls ? { class: cls, text: name } : { text: name }));
  });
  return tr;
}

// Ten ranked rows of dashes, for a board shown before any payload has arrived or
// after the first fetch failed.
function placeholderRows() {
  return Array.from({ length: BOARD_SIZE }, (_, i) => ({ rank: pad(i + 1), crown: false, day: '—', title: '—', score: '—', first: false, today: false }));
}

// Redraws the board name, the squares and the table for the current screen. It
// skips the rebuild when nothing it shows has changed, so a 5 s poll leaves the
// rows alone and a reader can select text in them.
function draw() {
  if (!built) return;
  const boards = shownBoards();
  const thisYear = new Date().getFullYear();
  const board = screen === 0 ? null : BOARDS[screen - 1];
  const rows = board ? (payload ? boardRows(board.key, boards[board.key] ?? [], thisYear) : placeholderRows()) : hallRows(boards, thisYear);
  const key = JSON.stringify([screen, rows]);
  if (key === drawnKey) return;
  drawnKey = key;

  nodes.name.textContent = board ? board.title : 'HALL OF FAME';
  nodes.dots.replaceChildren(...Array.from({ length: SCREENS }, (_, i) => el('span', i === screen ? { class: 'on', text: '■' } : { text: '■' })));

  const withTitle = board && (board.kind === 'session' || board.kind === 'turn');
  const head = board ? ['RANK', 'DAY', ...(withTitle ? ['TITLE'] : []), 'SCORE'] : ['RECORD', 'DAY', 'SCORE'];
  const body = rows.map((r, i) => {
    const first = board ? r.first : i === 0;
    const cls = [first ? 'first' : '', r.today ? 'today' : ''].filter(Boolean).join(' ');
    const lead = board ? { text: r.rank, crown: r.crown } : { text: r.label, crown: first };
    return tableRow([lead, { text: r.day }, ...(withTitle ? [{ text: r.title ?? '', cls: 'ttl' }] : []), { text: r.score, cls: 'n' }], cls);
  });
  nodes.table.replaceChildren(headerRow(head), ...body);
}

// Today's date as YYYY.MM.DD and the time as HH:MM, in the top-right box.
function tick() {
  const d = new Date();
  nodes.date.textContent = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  nodes.clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// CREDITS shows today's cost from the latest today summary, a dash before the first.
function drawCredits() {
  nodes.credits.textContent = lastLive ? `CREDITS ${formatCost(lastLive.cost)}` : 'CREDITS —';
}

// Moves to screen `i` (wrapping) and restarts the 6 s cycle, so a manual switch
// gets a full 6 s before the next automatic one.
function goTo(i) {
  screen = (i + SCREENS) % SCREENS;
  draw();
  restartCycle();
}

function restartCycle() {
  clearInterval(cycleTimer);
  cycleTimer = null;
  if (isVisible() && !reducedMotion()) cycleTimer = setInterval(() => goTo(screen + 1), CYCLE_MS);
}

// Starts or stops the clock and the cycle. Both run only while the tab is shown
// and the browser tab is not hidden. Without a started cycle it leaves the cycle
// timer as it is, so a poll never resets the 6 s count.
function syncTimers() {
  const visible = isVisible();
  if (visible && !clockTimer) {
    tick();
    clockTimer = setInterval(tick, CLOCK_MS);
  } else if (!visible && clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  if (visible && !cycleTimer && !reducedMotion()) restartCycle();
  if ((!visible || reducedMotion()) && cycleTimer) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
}

// Called when the tab is shown or hidden, by the tab switch and by the browser
// tab's visibility. It starts or stops the timers and draws from the last merge.
export function syncHighscores() {
  if (!built) return;
  syncTimers();
  if (isVisible()) {
    drawCredits();
    draw();
  }
}

// Builds the screen in #arcade once and wires the buttons, the arrow keys and the
// visibility events. Nothing is drawn with data yet: dashes show until the first
// fetch answers.
export function setupHighscores() {
  const root = document.getElementById('arcade');
  if (!root || built) return;
  document.querySelector('.topbar .title-logo')?.addEventListener('click', replayLatest);
  root.append(buildScene(), ...buildSides(), buildCenter());
  built = true;
  nodes.prev.addEventListener('click', () => goTo(screen - 1));
  nodes.next.addEventListener('click', () => goTo(screen + 1));
  document.addEventListener('keydown', (evt) => {
    if (!isVisible() || evt.altKey || evt.ctrlKey || evt.metaKey || evt.shiftKey) return;
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) return;
    goTo(screen + (evt.key === 'ArrowRight' ? 1 : -1));
  });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', syncHighscores);
  tick();
  drawCredits();
  draw();
  syncTimers();
}

// Fetches /api/highscores. A failed request keeps the last good payload; with no
// payload every row shows a dash. Numbered, so a slow answer cannot overwrite a
// newer one.
export function refreshHighscores() {
  const isLatest = loads.next();
  return getJson('/api/highscores', { optional: true }).then((data) => {
    if (!isLatest()) return;
    if (!data?.boards) {
      // A failed refetch clears the once-per-date mark, so the next poll (5 s) retries.
      staleRequestedFor = null;
      return;
    }
    payload = data;
    remerge();
    if (isVisible()) draw();
  });
}

// Merges the latest live values into the payload. A payload from an earlier date
// gives no merge: its boards stay on screen without today rows, one refetch is
// started per date, and lastMerged is null so nothing downstream compares today
// against boards that lack yesterday.
function remerge() {
  if (!payload) return null;
  const today = localDateStr(new Date());
  lastMerged = mergeToday(payload, lastLive, today);
  if (lastMerged === null && staleRequestedFor !== today) {
    staleRequestedFor = today;
    refreshHighscores();
  }
  return lastMerged === null ? null : today;
}

// Forgets the last poll's state, so the next poll only records. Called when the
// browser tab is shown again, so a record set while hidden does not play.
export function resetWatch() {
  prev = null;
}

// Compares this poll's first places with the last poll's and plays the header
// animation for each board that today just took. localStorage is read on every
// call so a play in another browser tab is seen. The property itself is read in a
// try, because blocked site data makes the getter throw; the watch then runs with
// no stored state. While an animation plays the step is skipped, so `prev` keeps
// the old state and a board that flips meanwhile is seen on the first poll after.
// A rejected animation is ignored.
function watchRecords(today) {
  if (isPlaying()) return;
  let storage = null;
  try {
    storage = globalThis.localStorage;
  } catch {
    // blocked site data
  }
  const result = step(prev, todayFirstKeys(lastMerged), today, readCelebrated(storage));
  prev = result.state;
  if (!result.play.length) return;
  writeCelebrated(storage, result.celebrated);
  playRecords(result.play, lastMerged);
}

// Plays the header animation for the boards in `keys`, one record per board.
function playRecords(keys, boards) {
  const records = keys.map((k) => ({ title: BOARDS.find((b) => b.key === k).title, score: scoreText(k, boards[k][0]) }));
  const reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  playRecordFx(document.querySelector('.topbar'), records, { reducedMotion })?.catch(() => {});
}

// Replays the most recent record when the header icon is clicked. It uses the
// merged boards, or the payload's boards before a merge, and does nothing with
// no payload. It writes no storage and leaves `prev` alone, so the watch is
// unaffected. A throw is logged and never leaves the handler.
function replayLatest() {
  try {
    const boards = lastMerged ?? payload?.boards;
    if (!boards) return;
    const keys = latestRecords(boards, localDateStr(new Date()));
    if (keys.length) playRecords(keys, boards);
  } catch (err) {
    console.error(err);
  }
}

// Called by renderSticky with every today summary, on every tab. It keeps the
// live values and the merged boards current, and redraws only while the tab shows.
export function onTodaySummary(data) {
  lastLive = data.todayRecords ?? null;
  const merged = remerge();
  if (merged) {
    // A fault in the watch or the animation must not stop the drawing below or the sticky bar.
    try {
      watchRecords(merged);
    } catch (err) {
      console.error(err);
    }
  }
  if (built) {
    drawCredits();
    if (isVisible()) draw();
  }
}

// The boards with today merged in, or null before the first fetch and while the
// payload is from an earlier date.
export function getMerged() {
  return lastMerged;
}
