'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildHighscores, todayRecords } = require('../lib/highscores');

const TODAY = '2026-10-16';
const YESTERDAY = '2026-10-15';
const D2 = '2026-10-14';
const D3 = '2026-10-12'; // a zero day, as fillAxis emits
const D1 = '2026-10-10';
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const CROSS_START = at(2026, 10, 15, 23);

const bucket = (date, tokens, extra = {}) => ({
  date, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0, cost: tokens / 1000,
  linesAdded: 0, linesRemoved: 0, ...extra,
});
const call = (sessionId, t, cost) => ({ t, sessionId, cost });

// 'cross' starts at 23:00 yesterday and has a call today. 'other' is yesterday only.
const calls = [
  call('cross', CROSS_START, 2),
  call('other', at(2026, 10, 15, 9), 1),
  call('cross', at(2026, 10, 16, 1), 5),
  call('old', at(2026, 10, 14, 9), 4),
];
const efficiency = {
  calls,
  prompts: [{ t: at(2026, 10, 15, 9), sessionId: 'other' }, { t: at(2026, 10, 14, 9), sessionId: 'old' }, { t: at(2026, 10, 14, 10), sessionId: 'old' }],
  turns: [
    { t: at(2026, 10, 14, 9), sessionId: 'old', durationMs: 60000 },
    { t: at(2026, 10, 16, 1), sessionId: 'cross', durationMs: 90000 },
  ],
  titleBySession: { old: 'Summary title' },
  handoffTitleBySession: { old: 'Handoff title' },
  firstPromptBySession: { other: 'first prompt', old: 'unused' },
};
const data = {
  daily: [bucket(D1, 1000), bucket(D3, 0), bucket(D2, 3000, { linesAdded: 7 }), bucket(YESTERDAY, 2000), bucket(TODAY, 9000)],
  efficiency,
};
const todayData = {
  daily: [bucket(`${TODAY}T01`, 500, { linesAdded: 2, linesRemoved: 1 }), bucket(`${TODAY}T02`, 700, { linesAdded: 3 })],
  efficiency: {
    calls: [call('cross', at(2026, 10, 16, 1), 5), call('cross', at(2026, 10, 16, 2), 1)],
    prompts: [{ t: at(2026, 10, 16, 1), sessionId: 'cross' }],
    turns: [efficiency.turns[1]],
    titleBySession: {},
    handoffTitleBySession: {},
    firstPromptBySession: { cross: 'a prompt' },
  },
};

test('day boards leave out today and skip zero days', () => {
  const p = buildHighscores(data, TODAY);
  assert.deepEqual(p.boards.tokens.map((x) => x.id), [D2, YESTERDAY, D1]);
  assert.equal(p.boards.tokens[0].score, 3000);
  assert.equal(p.boards.tokens[0].at, Date.parse(D2 + 'T00:00:00'));
  assert.equal(p.date, TODAY);
  assert.deepEqual(Object.keys(p.boards), ['tokens', 'cost', 'prompts', 'sessions', 'linesAdded', 'linesRemoved', 'session', 'turn', 'streak']);
  assert.deepEqual(p.boards.linesAdded.map((x) => x.id), [D2]);
  assert.deepEqual(p.boards.prompts.map((x) => [x.id, x.score]), [[D2, 2], [YESTERDAY, 1]]);
});

test('a session with a call today is left out of the board and carried', () => {
  const p = buildHighscores(data, TODAY);
  assert.ok(!p.boards.session.some((x) => x.id === 'cross'));
  assert.deepEqual(p.carry.cross, { cost: 2, at: CROSS_START });
  assert.deepEqual(p.boards.session.map((x) => [x.id, x.score, x.title]), [['old', 4, 'Handoff title'], ['other', 1, 'first prompt']]);
});

test('a session whose only cost is today is carried nowhere', () => {
  const p = buildHighscores({ ...data, efficiency: { ...efficiency, calls: [call('new', at(2026, 10, 16, 3), 3)] } }, TODAY);
  assert.deepEqual(p.carry, {});
});

test('sessions per day count a session that spans midnight on both days', () => {
  const p = buildHighscores(data, TODAY);
  assert.equal(p.boards.sessions.find((x) => x.id === YESTERDAY).score, 2);
});

test('turn board leaves out today and carries the session title', () => {
  const p = buildHighscores(data, TODAY);
  assert.deepEqual(p.boards.turn.map((x) => [x.id, x.score, x.title, x.date]), [['old:' + at(2026, 10, 14, 9), 60000, 'Handoff title', D2]]);
});

test('streak runs stop at a zero day, and currentRun is the run ending yesterday', () => {
  const p = buildHighscores(data, TODAY);
  assert.deepEqual(p.currentRun, { start: D2, end: YESTERDAY, days: 2 });
  assert.deepEqual(p.boards.streak.map((x) => [x.id, x.end, x.score]), [[D2, YESTERDAY, 2], [D1, D1, 1]]);
});

test('currentRun is null when yesterday has no tokens', () => {
  const p = buildHighscores({ ...data, daily: data.daily.filter((b) => b.date !== YESTERDAY) }, TODAY);
  assert.equal(p.currentRun, null);
});

test('todayRecords sums today and lists session costs and turns', () => {
  const live = todayRecords(todayData, TODAY);
  assert.deepEqual([live.date, live.sessions, live.sessionCosts[0].sessionId], [TODAY, 1, 'cross']);
  assert.equal(live.turns.length, 1);
  assert.deepEqual([live.tokens, live.linesAdded, live.linesRemoved, live.prompts], [1200, 5, 1, 1]);
  assert.deepEqual(live.sessionCosts[0], { sessionId: 'cross', cost: 6, at: at(2026, 10, 16, 1), title: 'a prompt' });
  assert.equal(live.turns[0].title, 'a prompt');
});
