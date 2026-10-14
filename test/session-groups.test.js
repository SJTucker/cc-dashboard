'use strict';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert');
let groupSessions, itemCost, costShare, splitBands, isRunning, costSplit, activityLabel, doingNow;
before(async () => { ({ groupSessions, itemCost, costShare, splitBands, isRunning, costSplit, activityLabel, doingNow } = await import('../public/session-groups.mjs')); });

function session(project, lastActiveAt, overrides = {}) {
  return {
    project, costUsd: 1, costTodayUsd: 0.5, durationMs: 1000, linesAdded: 2, linesRemoved: 1,
    tokens: 100, prompts: 3, spans: [], lastActiveAt, ended: 'clear', live: false, ...overrides,
  };
}

test('two ended sessions of one project become a group', () => {
  const items = groupSessions([session('a', 20), session('a', 10)]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].type, 'group');
  assert.strictEqual(items[0].project, 'a');
  assert.strictEqual(items[0].sessions.length, 2);
});

test('a single ended session of a project stays a plain item', () => {
  const s = session('a', 10);
  assert.deepStrictEqual(groupSessions([s]), [{ type: 'session', session: s }]);
});

test('live and idle open sessions are never grouped', () => {
  const sessions = [
    session('a', 30, { ended: null, live: true }),
    session('a', 20, { ended: null }),
    session('a', 10),
  ];
  assert.deepStrictEqual(groupSessions(sessions).map((i) => i.type), ['session', 'session', 'session']);
});

test('ended sessions group even when open sessions of the project exist', () => {
  const items = groupSessions([session('a', 30, { ended: null, live: true, costTodayUsd: 5 }), session('a', 20), session('a', 10)]);
  assert.deepStrictEqual(items.map((i) => i.type), ['session', 'group']);
});

test('group fields sum the sessions and take the newest lastActiveAt', () => {
  const [g] = groupSessions([session('a', 20), session('a', 10, { costUsd: 2, tokens: 50 })]);
  assert.strictEqual(g.costUsd, 3);
  assert.strictEqual(g.costTodayUsd, 1);
  assert.strictEqual(g.durationMs, 2000);
  assert.strictEqual(g.linesAdded, 4);
  assert.strictEqual(g.linesRemoved, 2);
  assert.strictEqual(g.tokens, 150);
  assert.strictEqual(g.prompts, 6);
  assert.strictEqual(g.lastActiveAt, 20);
});

test('rows are sorted by Cost today, highest first, and a group counts by its summed cost', () => {
  const items = groupSessions([
    session('a', 50, { ended: null, live: true, costTodayUsd: 0.4 }),
    session('b', 40, { costTodayUsd: 0.3 }),
    session('c', 30, { ended: null, costTodayUsd: 0.9 }),
    session('b', 20, { costTodayUsd: 0.3 }),
  ]);
  // c: 0.9, group b: 0.6, a: 0.4
  assert.deepStrictEqual(items.map((i) => i.type), ['session', 'group', 'session']);
  assert.deepStrictEqual(items.map((i) => i.type === 'group' ? i.project : i.session.project), ['c', 'b', 'a']);
});

test('rows with equal Cost today are ordered newest lastActiveAt first, including when every cost is 0', () => {
  const items = groupSessions([
    session('a', 10, { ended: null, costTodayUsd: 0 }),
    session('b', 30, { ended: null, costTodayUsd: 0 }),
    session('c', 20, { ended: null, costTodayUsd: 0 }),
  ]);
  assert.deepStrictEqual(items.map((i) => i.session.project), ['b', 'c', 'a']);
});

test('itemCost reads a plain row and a group the same way', () => {
  const [g] = groupSessions([session('a', 20), session('a', 10)]);
  assert.strictEqual(itemCost(g), 1);
  assert.strictEqual(itemCost({ type: 'session', session: session('b', 1, { costTodayUsd: 2.5 }) }), 2.5);
});

test('costShare is the value over the maximum, clamped, and 0 when the maximum is 0', () => {
  assert.strictEqual(costShare(2, 8), 0.25);
  assert.strictEqual(costShare(9, 8), 1);
  assert.strictEqual(costShare(0, 0), 0);
  assert.strictEqual(costShare(1, 0), 0);
  assert.strictEqual(costShare(-1, 8), 0);
});

test('a group keeps its sessions in incoming order', () => {
  const [g] = groupSessions([session('a', 30), session('a', 20), session('a', 10)]);
  assert.deepStrictEqual(g.sessions.map((s) => s.lastActiveAt), [30, 20, 10]);
});

test('cleared counts ended === clear and ended counts every other end', () => {
  const [g] = groupSessions([
    session('a', 30), session('a', 20, { ended: 'other' }), session('a', 10, { ended: 'logout' }),
  ]);
  assert.strictEqual(g.cleared, 1);
  assert.strictEqual(g.ended, 2);
});

test('sessions with a null project group together', () => {
  const [g] = groupSessions([session(null, 20), session(null, 10)]);
  assert.strictEqual(g.type, 'group');
  assert.strictEqual(g.project, null);
});

test('activityLabel gives each state its own glyph and words, so no state depends on colour', () => {
  assert.deepStrictEqual(activityLabel({ state: 'working' }), { glyph: '▶', label: 'working', attention: false, text: '▶ working' });
  assert.deepStrictEqual(activityLabel({ state: 'waiting' }), { glyph: '⏸', label: 'waiting on you', attention: true, text: '⏸ waiting on you' });
});

test('activityLabel is null without activity or with an unknown state', () => {
  assert.strictEqual(activityLabel(null), null);
  assert.strictEqual(activityLabel(undefined), null);
  assert.strictEqual(activityLabel({ state: 'constructor' }), null);
  assert.strictEqual(activityLabel({ state: 'approval' }), null);
});

test('doingNow shows the tool name without its detail, and the subagent count when there is one', () => {
  const tool = { name: 'Bash', detail: 'npm test', startedAt: 1 };
  assert.strictEqual(doingNow({ state: 'working', tool, subagents: 0 }), 'Bash');
  assert.strictEqual(doingNow({ state: 'working', tool: { ...tool, detail: '' }, subagents: 0 }), 'Bash');
  assert.strictEqual(doingNow({ state: 'working', tool, subagents: 2 }), 'Bash · 2 subagents');
  assert.strictEqual(doingNow({ state: 'working', tool: null, subagents: 1 }), '1 subagent');
});

test('doingNow is null with no activity, or nothing running', () => {
  assert.strictEqual(doingNow(null), null);
  assert.strictEqual(doingNow({ state: 'waiting', tool: null, subagents: 0 }), null);
});

test('two sessions of one launch group even when one of them is live', () => {
  const items = groupSessions([
    session('a', 30, { ended: null, live: true, launchId: 'L1' }),
    session('a', 20, { launchId: 'L1' }),
  ]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'launch');
  assert.strictEqual(items[0].key, 'launch:L1');
  assert.strictEqual(items[0].sessions.length, 2);
  assert.strictEqual(items[0].live, true);
});

test('a launch group takes head, project and lastActiveAt from its newest session', () => {
  const newest = session('a', 30, { ended: null, launchId: 'L1', costTodayUsd: 1 });
  const [g] = groupSessions([newest, session('a', 20, { launchId: 'L1' })]);
  assert.strictEqual(g.head, newest);
  assert.strictEqual(g.project, 'a');
  assert.strictEqual(g.lastActiveAt, 30);
  assert.strictEqual(g.costTodayUsd, 1.5);
});

test('a launch whose sessions all ended is not live', () => {
  const [g] = groupSessions([
    session('a', 30, { ended: 'other', launchId: 'L1' }),
    session('a', 20, { launchId: 'L1' }),
    session('a', 10, { launchId: 'L1' }),
  ]);
  assert.strictEqual(g.live, false);
  assert.strictEqual(g.cleared, 2);
  assert.strictEqual(g.ended, 1);
});

test("cleared and ended leave out a launch's open session", () => {
  const [g] = groupSessions([
    session('a', 30, { ended: null, live: false, launchId: 'L1' }),
    session('a', 20, { launchId: 'L1' }),
  ]);
  assert.strictEqual(g.live, false);
  assert.strictEqual(g.cleared, 1);
  assert.strictEqual(g.ended, 0);
});

test('a single-session launch falls through to project grouping once ended', () => {
  const items = groupSessions([session('a', 20, { launchId: 'L1' }), session('a', 10, { launchId: 'L2' })]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'project');
  assert.strictEqual(items[0].key, 'project:a');
});

test('a session in a launch group never also joins a project group', () => {
  const items = groupSessions([
    session('a', 40, { launchId: 'L1' }),
    session('a', 30, { launchId: 'L1' }),
    session('a', 20),
  ]);
  assert.deepStrictEqual(items.map((i) => i.type === 'group' ? i.kind : 'session'), ['launch', 'session']);
  assert.strictEqual(items[0].sessions.length, 2);
});

test('sessions without a launchId group by project as before', () => {
  const items = groupSessions([session('a', 20, { launchId: null }), session('a', 10)]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'project');
  assert.strictEqual(items[0].sessions.length, 2);
});

test('a project and a launch with the same name get different keys', () => {
  const items = groupSessions([
    session('L1', 40, { launchId: 'L1' }), session('L1', 30, { launchId: 'L1' }),
    session('L1', 20), session('L1', 10),
  ]);
  const keys = items.map((i) => i.key);
  assert.strictEqual(new Set(keys).size, 2);
  assert.deepStrictEqual(keys.sort(), ['launch:L1', 'project:L1']);
});

test('a null project gets the key project: with nothing after it', () => {
  const [g] = groupSessions([session(null, 20), session(null, 10)]);
  assert.strictEqual(g.key, 'project:');
});

let cacheLine;
before(async () => { ({ cacheLine } = await import('../public/session-groups.mjs')); });
const usd = (n) => '$' + n.toFixed(2);

test('cacheLine shows minutes left and the rebuild cost', () => {
  assert.strictEqual(cacheLine({ minutesLeft: 4, rebuildUsd: 0.38 }, usd), 'cache 4 min left · $0.38 to rebuild after');
});

test('cacheLine says under 1 min when no whole minute is left', () => {
  assert.strictEqual(cacheLine({ minutesLeft: 0, rebuildUsd: 0.38 }, usd), 'cache expires in under 1 min · $0.38 to rebuild after');
});

test('cacheLine says expired when minutesLeft is negative', () => {
  assert.strictEqual(cacheLine({ minutesLeft: -1, rebuildUsd: 0.38 }, usd), 'cache expired · next reply pays $0.38 to rebuild');
});

test('cacheLine drops the cost clause when rebuildUsd is null', () => {
  assert.strictEqual(cacheLine({ minutesLeft: 4, rebuildUsd: null }, usd), 'cache 4 min left');
  assert.strictEqual(cacheLine({ minutesLeft: 0, rebuildUsd: null }, usd), 'cache expires in under 1 min');
  assert.strictEqual(cacheLine({ minutesLeft: -3, rebuildUsd: null }, usd), 'cache expired');
});

test('cacheLine is null without a cache', () => {
  assert.strictEqual(cacheLine(undefined), null);
  assert.strictEqual(cacheLine(null), null);
});

const runningNames = (bands) => bands.running.map((r) => r.session.project);

test('isRunning is true for a live session or one waiting on the user', () => {
  assert.strictEqual(isRunning({ live: true }), true);
  assert.strictEqual(isRunning({ live: false, activity: { state: 'waiting' } }), true);
  assert.strictEqual(isRunning({ live: false, activity: { state: 'working' } }), false);
  assert.strictEqual(isRunning({ live: false }), false);
});

test('splitBands puts live sessions in running, ordered by first span start, and the rest in earlier', () => {
  const a = session('a', 100, { ended: null, live: true, spans: [[500, 600]] });
  const b = session('b', 90, { ended: null, live: true, spans: [[100, 200], [400, 450]] });
  const idle = session('c', 80, { ended: null, live: false, spans: [[1, 2]] });
  const done = session('d', 70, { spans: [[1, 2]] });
  const bands = splitBands(groupSessions([a, idle, b, done]));
  assert.deepStrictEqual(runningNames(bands), ['b', 'a']);
  assert.deepStrictEqual(bands.running.map((r) => r.item.type), ['session', 'session']);
  assert.deepStrictEqual(bands.earlier.map((i) => i.session.project).sort(), ['c', 'd']);
});

test('splitBands puts a session with no span last and breaks ties by newest lastActiveAt', () => {
  const none = session('none', 100, { ended: null, live: true, spans: [] });
  const noSpans = session('no-spans', 5, { ended: null, live: true });
  delete noSpans.spans;
  const tieOld = session('tie-old', 10, { ended: null, live: true, spans: [[100, 100]] });
  const tieNew = session('tie-new', 20, { ended: null, live: true, spans: [[100, 100]] });
  assert.deepStrictEqual(runningNames(splitBands(groupSessions([none, noSpans, tieOld, tieNew]))), ['tie-new', 'tie-old', 'none', 'no-spans']);
});

test('splitBands keeps a session waiting on you after it stops being live', () => {
  const base = { spans: [[1, 2]], lastActiveAt: 2, live: false };
  const waiting = { ...base, project: 'waiting', activity: { state: 'waiting' } };
  const approval = { ...base, project: 'approval', spans: [[3, 4]], activity: { state: 'approval' } };
  const stale = { ...base, project: 'stale', activity: null };
  const working = { ...base, project: 'working', activity: { state: 'working' } };
  const bands = splitBands(groupSessions([stale, approval, working, waiting]));
  assert.deepStrictEqual(runningNames(bands), ['waiting']);
  assert.strictEqual(bands.earlier.length, 3);
});

test('splitBands returns a launch group whose newest session is running, with that session', () => {
  const newest = session('a', 30, { ended: null, live: true, launchId: 'L1', spans: [[10, 30]] });
  const bands = splitBands(groupSessions([newest, session('a', 20, { launchId: 'L1' }), session('a', 10, { launchId: 'L1' })]));
  assert.strictEqual(bands.running.length, 1);
  assert.strictEqual(bands.running[0].item.kind, 'launch');
  assert.strictEqual(bands.running[0].session, newest);
  assert.deepStrictEqual(bands.earlier, []);
});

test('splitBands leaves a launch group of cleared sessions in earlier', () => {
  const bands = splitBands(groupSessions([session('a', 30, { launchId: 'L1' }), session('a', 20, { launchId: 'L1' })]));
  assert.deepStrictEqual(bands.running, []);
  assert.strictEqual(bands.earlier.length, 1);
});

test('splitBands keeps earlier in groupSessions order and returns empty bands for no items', () => {
  const items = groupSessions([session('a', 10, { costTodayUsd: 1 }), session('b', 20, { costTodayUsd: 3 })]);
  assert.deepStrictEqual(splitBands(items).earlier, items);
  assert.deepStrictEqual(splitBands([]), { running: [], earlier: [] });
});

test('costSplit of a single session is all newest', () => {
  assert.deepStrictEqual(costSplit({ type: 'session', session: session('a', 1, { costTodayUsd: 2 }) }), { newest: 2, earlier: 0 });
});

test('costSplit of a group is the head session and the rest', () => {
  const [g] = groupSessions([
    session('a', 30, { launchId: 'L1', costTodayUsd: 1 }),
    session('a', 20, { launchId: 'L1', costTodayUsd: 0.25 }),
    session('a', 10, { launchId: 'L1', costTodayUsd: 0.5 }),
  ]);
  assert.deepStrictEqual(costSplit(g), { newest: 1, earlier: 0.75 });
});

test('costSplit with a newest cost of 0 puts all of the cost in earlier', () => {
  const [g] = groupSessions([
    session('a', 30, { launchId: 'L1', costTodayUsd: 0 }),
    session('a', 20, { launchId: 'L1', costTodayUsd: 2 }),
  ]);
  assert.deepStrictEqual(costSplit(g), { newest: 0, earlier: 2 });
});

test('a session resumed in a new process and then cleared groups with the session it cleared', () => {
  const resumed = session('a', 20, { sessionId: 's1', launchId: 'L1' });
  const next = session('a', 30, { sessionId: 's2', launchId: 'L2', clearedFrom: 's1', ended: null, live: true });
  const items = groupSessions([next, resumed]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'launch');
  assert.deepStrictEqual(items[0].sessions, [next, resumed]);
  assert.strictEqual(items[0].head, next);
  assert.strictEqual(items[0].live, true);
});

test('a /clear chain joins the launch groups of two processes into one group', () => {
  const a = session('a', 10, { sessionId: 's1', launchId: 'L1' });
  const b = session('a', 20, { sessionId: 's2', launchId: 'L1', clearedFrom: 's1' });
  const c = session('a', 30, { sessionId: 's3', launchId: 'L2', clearedFrom: 's2' });
  const d = session('a', 40, { sessionId: 's4', launchId: 'L2', clearedFrom: 's3', ended: null });
  const items = groupSessions([d, c, b, a]);
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0].sessions, [d, c, b, a]);
  assert.strictEqual(items[0].head, d);
});

test('a clearedFrom naming a session not in the list joins nothing', () => {
  const s = session('a', 20, { sessionId: 's2', launchId: 'L2', clearedFrom: 'yesterday', ended: null });
  assert.deepStrictEqual(groupSessions([s]), [{ type: 'session', session: s }]);
});

test("a chain's key comes from its first session to start, so a session that joins later keeps it", () => {
  const a = session('a', 10, { sessionId: 's1', launchId: 'L9', spans: [[100, 200]] });
  const b = session('a', 20, { sessionId: 's2', launchId: 'L9', clearedFrom: 's1', spans: [[300, 400]] });
  const c = session('a', 30, { sessionId: 's3', launchId: 'L1', clearedFrom: 's2', spans: [[500, 600]], ended: null });
  assert.strictEqual(groupSessions([b, a])[0].key, 'launch:L9');
  // L1 sorts before L9, so a key taken from the smallest launchId would change here.
  const after = groupSessions([c, b, a]);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].key, 'launch:L9');
});
