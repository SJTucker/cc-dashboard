'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/orchestration/view.mjs');

test('statusView gives every status a glyph and a word', async () => {
  const { statusView } = await load();
  for (const s of ['working', 'quiet', 'starting', 'stuck', 'done', 'review', 'passed', 'changes', 'merged']) {
    const v = statusView(s);
    assert.ok(v.glyph && v.word, s);
  }
  assert.equal(statusView('stuck').tone, 'warn');
  assert.equal(statusView('working').tone, 'live');
  assert.equal(statusView('merged').tone, 'plain');
  assert.equal(statusView('changes').glyph, '↺');
  assert.equal(statusView('starting').glyph, '◌');
});

test('switcherState words follow waiting, phase and liveness', async () => {
  const { switcherState } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(switcherState({ waiting: true, phase: 'waves', wave: 2, live: true }, now), 'Waiting for you');
  assert.equal(switcherState({ waiting: false, phase: 'waves', wave: 2, live: true }, now), 'Wave 2');
  assert.equal(switcherState({ phase: 'plan', live: true }, now), 'Planning');
  assert.equal(switcherState({ phase: 'reset', live: true }, now), 'Reset');
  assert.equal(switcherState({ phase: 'finish', live: false, lastActiveAt: now - 3 * 3600_000 }, now), 'Finished 3h ago');
  assert.equal(switcherState({ phase: 'finish', live: false, lastActiveAt: now - 20_000 }, now), 'Finished just now');
  assert.equal(switcherState({ phase: 'waves', wave: null, live: true }, now), 'Waves');
});

test('meterRatio is tokens over the 200000 budget, clamped to 1', async () => {
  const { meterRatio } = await load();
  assert.equal(meterRatio(100000), 0.5);
  assert.equal(meterRatio(210000), 1);
  assert.equal(meterRatio(null), 0);
});

test('phaseSteps marks earlier steps done and the current one now', async () => {
  const { phaseSteps } = await load();
  assert.deepEqual(phaseSteps('waves', true).map((s) => s.state), ['done', 'done', 'now', 'todo']);
  assert.deepEqual(phaseSteps('finish', false).map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(phaseSteps('plan', true).map((s) => s.name), ['Plan', 'Reset', 'Waves', 'Finish']);
});

test('countsLine lists only the non-zero counts', async () => {
  const { countsLine } = await load();
  assert.equal(countsLine({ working: 2, review: 0, merged: 1, attention: 0 }), '2 working · 1 merged');
  assert.equal(countsLine({ working: 0, review: 0, merged: 0, attention: 0 }), 'no workers yet');
});

test('postTime reads as minutes ago under an hour and as a 24-hour clock after', async () => {
  const { postTime } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(postTime(new Date(now - 4 * 60_000).toISOString(), now), '4m ago');
  assert.equal(postTime(new Date(now - 10_000).toISOString(), now), 'just now');
  assert.match(postTime(new Date(now - 3 * 3600_000).toISOString(), now), /^\d\d:\d\d$/);
});

test('reviewLabel says Reviewer running for a running review', async () => {
  const { reviewLabel } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const startedAt = new Date(now - 120_000).toISOString();
  assert.equal(reviewLabel({ status: 'running', startedAt }, now), '◐ Reviewer running · 2m');
  assert.equal(reviewLabel({ status: 'passed', startedAt, endedAt: new Date(now).toISOString() }, now), '✓ Reviewer passed · 2m');
  assert.equal(reviewLabel({ status: 'changes', startedAt, endedAt: new Date(now).toISOString() }, now), '↺ Reviewer changes asked · 2m');
});

test('steerView covers every state', async () => {
  const { steerView } = await load();
  assert.equal(steerView(null), null);
  assert.deepEqual(steerView({ state: 'pending' }), { word: 'Sending…', tone: 'plain' });
  const delivered = steerView({ state: 'delivered', at: Date.parse('2026-11-10T14:06:00') });
  assert.match(delivered.word, /^Delivered \d\d:\d\d$/);
  assert.equal(delivered.tone, 'plain');
  assert.deepEqual(steerView({ state: 'failed', reason: 'no such session' }), { word: 'Not delivered: no such session', tone: 'warn' });
  assert.deepEqual(steerView({ state: 'unclaimed' }), { word: 'Not picked up. Is the orchestrator session still open?', tone: 'warn' });
});

test('steerView tells an expired steer to be sent again', async () => {
  const { steerView } = await load();
  assert.deepEqual(steerView({ state: 'failed', reason: 'expired' }), { word: 'Not sent: it reached the orchestrator too late. Send it again.', tone: 'warn' });
});

test('boardError explains a missing board, a missing title and any other refusal', async () => {
  const { boardError } = await load();
  assert.match(boardError(409, { error: 'no board yet' }), /no board yet/);
  assert.equal(boardError(400, { error: 'x' }), 'Write a title first.');
  assert.equal(boardError(500, {}), 'Could not post. The server said 500.');
});

test('steerError words each refusal of a steer', async () => {
  const { steerError } = await load();
  assert.equal(steerError(409, { error: 'worker finished' }), 'This worker has finished, so it was not steered.');
  assert.equal(steerError(409, { error: 'orchestrator not live' }), 'The orchestrator session is not running, so nothing can deliver the message.');
  assert.equal(steerError(400, {}), 'Write a message first.');
  assert.equal(steerError(404, {}), 'Could not send. The server said 404.');
});

test('steerView says plain Not delivered when a failed steer has no reason', async () => {
  const { steerView } = await load();
  assert.deepEqual(steerView({ state: 'failed', reason: null }), { word: 'Not delivered', tone: 'warn' });
  assert.deepEqual(steerView({ state: 'failed' }), { word: 'Not delivered', tone: 'warn' });
});

test('steerError asks for a message only when the text is empty, else says it is too long or not valid', async () => {
  const { steerError } = await load();
  assert.equal(steerError(400, {}, '   '), 'Write a message first.');
  assert.equal(steerError(400, {}, ''), 'Write a message first.');
  assert.equal(steerError(400, {}, 'x'.repeat(2001)), 'The message is too long or not valid.');
});

test('a dead orchestration that never reached Finish reads Ended', async () => {
  const { switcherState } = await load();
  const now = Date.now();
  assert.equal(switcherState({ phase: 'waves', wave: 2, live: false, lastActiveAt: now - 2 * 3600_000 }, now), 'Ended 2h ago');
  assert.equal(switcherState({ phase: 'plan', live: false, lastActiveAt: now - 20_000 }, now), 'Ended just now');
});

test('stepAge reads now, then an age with ago, never a minus sign', async () => {
  const { stepAge } = await load();
  const now = Date.now();
  assert.equal(stepAge(0, new Date(now - 60_000).toISOString(), now), 'now');
  assert.equal(stepAge(1, new Date(now - 60_000).toISOString(), now), '1m ago');
});

test('an ended orchestration reads Ended just now under a minute and Ended 2h ago after', async () => {
  const { switcherState } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(switcherState({ phase: 'waves', wave: 1, live: false, lastActiveAt: now - 30_000 }, now), 'Ended just now');
  assert.equal(switcherState({ phase: 'plan', live: false, lastActiveAt: now - 2 * 3600_000 }, now), 'Ended 2h ago');
  assert.equal(switcherState({ phase: 'reset', live: false, lastActiveAt: now - 5 * 60_000 }, now), 'Ended 5m ago');
  assert.equal(switcherState({ phase: 'finish', live: true }, now), 'Finishing');
});

test('postTime and switcherState share one seconds test', async () => {
  const { postTime, isSeconds } = await load();
  assert.equal(isSeconds('30s'), true);
  assert.equal(isSeconds('2m'), false);
  assert.equal(isSeconds('4h'), false);
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(postTime(new Date(now - 30_000).toISOString(), now), 'just now');
  assert.equal(postTime(new Date(now - 120_000).toISOString(), now), '2m ago');
});

test('unseenPosts counts only posts from others beyond the stored count, newest first', async () => {
  const { unseenPosts, othersCount } = await load();
  const board = [{ from: 'You' }, { from: 'a' }, { from: 'b' }, { from: 'c' }, { from: 'd' }, { from: 'e' }];
  assert.equal(othersCount(board), 5);
  assert.deepEqual([...unseenPosts(board, 3)], [board[1], board[2]]);
  assert.equal(unseenPosts(board, 9).size, 0);
});

test('boardError asks for a title only when the title is empty, else says the text is too long', async () => {
  const { boardError } = await load();
  assert.equal(boardError(400, {}, ''), 'Write a title first.');
  assert.equal(boardError(400, {}, '   '), 'Write a title first.');
  assert.equal(boardError(400, {}, 'x'.repeat(121)), 'The title or details are too long.');
  assert.equal(boardError(400, {}, 'Fine title'), 'The title or details are too long.');
  assert.equal(boardError(500, {}, 'x'), 'Could not post. The server said 500.');
});

test('reviewLabel stops counting at endedAt, and shows a dash for an unreadable time', async () => {
  const { reviewLabel } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const startedAt = new Date(now - 3600_000).toISOString();
  const endedAt = new Date(now - 3600_000 + 120_000).toISOString();
  assert.equal(reviewLabel({ status: 'passed', startedAt, endedAt }, now), '✓ Reviewer passed · 2m');
  assert.equal(reviewLabel({ status: 'passed', startedAt: null, endedAt }, now), '✓ Reviewer passed · —');
  assert.equal(reviewLabel({ status: 'running', startedAt: undefined }, now), '◐ Reviewer running · —');
  assert.equal(reviewLabel({ status: 'passed', startedAt, endedAt: 'garbage' }, now), '✓ Reviewer passed · —');
});

test('steerView words a timed-out and an invalid-request failure as actions', async () => {
  const { steerView } = await load();
  // These reason strings are written by mod/hooks/steer.ts.
  assert.deepEqual(steerView({ state: 'failed', reason: 'timed out (it may still arrive)' }), {
    word: 'Not confirmed: the send timed out. It may still arrive, so check the worker before sending again.', tone: 'warn',
  });
  assert.deepEqual(steerView({ state: 'failed', reason: 'invalid request' }), {
    word: 'Not sent: the request was not valid. Send it again.', tone: 'warn',
  });
});

test('boardError and steerError word a 413 like text that is too long', async () => {
  const { boardError, steerError } = await load();
  assert.equal(boardError(413, null, 'A title'), 'The title or details are too long.');
  assert.equal(steerError(413, null, 'hello'), 'The message is too long or not valid.');
});

test('a settled review with no endedAt shows a dash and does not count up', async () => {
  const { reviewLabel } = await load();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const startedAt = new Date(now - 120_000).toISOString();
  assert.equal(reviewLabel({ status: 'passed', startedAt }, now), '✓ Reviewer passed · —');
  assert.equal(reviewLabel({ status: 'changes', startedAt, endedAt: null }, now + 3600_000), '↺ Reviewer changes asked · —');
});

const T = (hhmm) => `2026-11-17T${hhmm}:00.000Z`;

test('contextView marks 150k and over as warn', async () => {
  const { contextView } = await load();
  assert.deepEqual(contextView(63200), { value: '63.2k', left: '137k left', ratio: 0.316, warn: false });
  assert.equal(contextView(150000).warn, true);
  const over = contextView(212000);
  assert.equal(over.left, '12k over');
  assert.equal(over.ratio, 1);
  assert.deepEqual(contextView(null), { value: '—', left: '', ratio: 0, warn: false });
});

test('filesView marks touched files and lists edits outside the plan', async () => {
  const { filesView } = await load();
  const v = filesView({ files: ['src/a.py', 'b.py'], touched: ['/w/t1/src/a.py'], edited: ['/w/t1/src/a.py', '/w/t1/c.py'] });
  assert.deepEqual(v, { cells: [{ path: 'src/a.py', touched: true }, { path: 'b.py', touched: false }], outside: ['/w/t1/c.py'] });
  const dir = filesView({ files: ['lib/'], touched: ['/w/t1/lib/x.js'], edited: ['/w/t1/lib/x.js'] });
  assert.equal(dir.cells[0].touched, true);
  assert.deepEqual(filesView({ files: [], touched: [], edited: [] }).cells, []);
  assert.deepEqual(filesView({}).cells, []);
});

test('reviewHistory words every round', async () => {
  const { reviewHistory } = await load();
  const r = (...s) => s.map((status) => ({ status }));
  assert.equal(reviewHistory([]), 'no review');
  assert.equal(reviewHistory(undefined), 'no review');
  assert.equal(reviewHistory(r('passed')), 'passed first time');
  assert.equal(reviewHistory(r('changes', 'passed')), 'changes asked, then passed');
  assert.equal(reviewHistory(r('changes', 'changes', 'passed')), 'changes asked ×2, then passed');
  assert.equal(reviewHistory(r('changes', 'running')), 'changes asked, then in review');
});

test('tookLabel gives a duration or a dash', async () => {
  const { tookLabel } = await load();
  assert.equal(tookLabel(T('11:18'), T('11:22')), '4m');
  assert.equal(tookLabel(T('11:18'), null), '—');
  assert.equal(tookLabel(undefined, T('11:22')), '—');
});

test('waveSpans measures each wave', async () => {
  const { waveSpans } = await load();
  const now = Date.parse(T('13:00'));
  const waves = [
    { n: 1, startedAt: T('10:00'), endedAt: T('10:46') },
    { n: 2, startedAt: T('11:00'), endedAt: null },
    { n: 3, startedAt: T('12:00'), endedAt: null },
  ];
  const live = waveSpans(waves, { live: true, now });
  assert.equal(live[0].ms, 46 * 60000);
  assert.equal(live[1].ms, 60 * 60000);
  assert.equal(live[2].ms, 60 * 60000);
  assert.equal(live[2].running, true);
  assert.equal(live[0].running, false);
  assert.equal(live[2].n, 3);
  const mergedLast = waveSpans([{ n: 1, startedAt: T('12:00'), endedAt: T('12:30') }], { live: true, now });
  assert.equal(mergedLast[0].ms, 30 * 60000);
  assert.equal(mergedLast[0].running, false);
  const ended = waveSpans([{ n: 1, startedAt: T('12:00'), endedAt: null }], { live: false, now });
  assert.equal(ended[0].ms, null);
  assert.equal(ended[0].running, false);
});

test('foldFeed folds consecutive routine entries', async () => {
  const { foldFeed, clock } = await load();
  // The feed is newest first, so a higher index is an older entry.
  const e = (i, glyph) => ({ at: T(`10:0${7 - i}`), line: 10 - i, glyph, text: `t${i}` });
  const feed = [e(1, '·'), e(2, '·'), e(3, '◆'), e(4, '✓'), e(5, '·'), e(6, '▸')];
  const out = foldFeed(feed);
  assert.deepEqual(out.map((x) => x.kind), ['group', 'entry', 'entry', 'group', 'entry']);
  assert.equal(out[0].entries.length, 2);
  assert.equal(out[0].label, `2 routine checks · ${clock(feed[1].at)}–${clock(feed[0].at)}`);
  assert.equal(out[0].key, `g:${feed[1].at}|${feed[1].line}`);
  assert.equal(out[3].label, `1 routine check · ${clock(feed[4].at)}`);
  const allRoutine = foldFeed([e(1, '·'), e(2, '·')]);
  assert.equal(allRoutine.length, 1);
  assert.equal(allRoutine[0].kind, 'group');
});

const stuckWorker = (task, text = `STUCK Bash ${task}`) => ({ task, status: 'stuck', events: [{ type: 'MSG', text: 'x', at: T('10:00') }, { type: 'DRIFT', text: `DRIFT older ${task}`, at: T('10:02') }, { type: 'STUCK', text, at: T('10:05') }] });

test('attentionItems puts waiting first, then stuck workers in task order', async () => {
  const { attentionItems } = await load();
  const detail = { live: true, now: { state: 'waiting', detail: 'Which one?', since: T('10:30') }, waves: [{ n: 1, workers: [stuckWorker(4), { task: 3, status: 'working', events: [] }, stuckWorker(2)] }] };
  const items = attentionItems(detail);
  assert.deepEqual(items.map((i) => i.kind), ['waiting', 'stuck', 'stuck']);
  assert.deepEqual(items.slice(1).map((i) => i.worker.task), [2, 4]);
  assert.deepEqual(items[1].event, { type: 'STUCK', text: 'STUCK Bash 2', at: T('10:05') });
  assert.equal(items[0].text, 'Which one?');
  assert.equal(items[0].since, T('10:30'));
  assert.deepEqual(attentionItems({ ...detail, live: false }).map((i) => i.kind), ['stuck', 'stuck']);
});

test('runCard builds the pill, meta, four pips and four counts', async () => {
  const { runCard, clock } = await load();
  const now = Date.parse(T('12:00'));
  const base = { project: 'f-forge', branch: 'qmd-search', wave: 4, lastActiveAt: now - 60000, boardCount: 0, phase: 'waves', live: true, waiting: false, counts: { working: 2, review: 0, merged: 1, attention: 0 } };
  const wait = runCard({ ...base, waiting: true }, now);
  assert.equal(wait.pill.text, 'Waiting for you');
  assert.equal(wait.pill.tone, 'warn');
  assert.equal(wait.pips.length, 4);
  assert.equal(wait.pips.find((p) => p.state === 'now').wait, true);
  assert.equal(wait.pips.find((p) => p.state === 'now').name, 'Waves');
  const live = runCard(base, now);
  assert.equal(live.pill.text, 'Live');
  assert.equal(live.pill.tone, 'live');
  assert.equal(live.pips.find((p) => p.state === 'now').wait, false);
  assert.deepEqual(live.pips.map((p) => p.state), ['done', 'done', 'now', 'next']);
  assert.deepEqual(live.meta, ['f-forge', 'qmd-search', 'wave 4', `last active ${clock(base.lastActiveAt)}`, 'board 0']);
  assert.deepEqual(runCard({ ...base, branch: null }, now).meta.slice(0, 2), ['f-forge', 'wave 4']);
  assert.deepEqual(live.counts.map((c) => c.word), ['working', 'review', 'merged', 'attention']);
  assert.deepEqual(live.counts.map((c) => c.tone), ['plain', 'zero', 'plain', 'zero']);
  assert.equal(runCard({ ...base, counts: { ...base.counts, attention: 1 } }, now).counts[3].tone, 'warn');
  const off = runCard({ ...base, live: false, phase: 'finish' }, now);
  assert.equal(off.pill.glyph, '○');
  assert.equal(off.pill.tone, 'plain');
  assert.match(off.pill.text, /^Finished/);
});

test('steerState gives glyph, word, sub, again and drain', async () => {
  const { steerState, steerView } = await load();
  const now = Date.parse(T('12:00'));
  const at = (ms) => new Date(now - ms).toISOString();
  const p = steerState({ state: 'pending', at: at(12000) }, now);
  assert.deepEqual({ glyph: p.glyph, word: p.word, again: p.again, drainMs: p.drainMs }, { glyph: '◌', word: 'Pending', again: false, drainMs: 18000 });
  assert.equal(p.sub, 'Waiting for the orchestrator session to pick it up.');
  assert.equal(steerState({ state: 'pending', at: at(40000) }, now).drainMs, 0);
  assert.equal(steerState({ state: 'pending', at: at(-600000) }, now).drainMs, 30000);
  const failed = { state: 'failed', reason: 'expired', at: at(1000) };
  const f = steerState(failed, now);
  assert.equal(f.again, true);
  assert.equal(f.sub, steerView(failed).word);
  const u = steerState({ state: 'unclaimed', at: at(1000) }, now);
  assert.equal(u.glyph, '○');
  assert.equal(u.again, true);
  assert.equal(steerState({ state: 'delivered', at: at(1000) }, now).glyph, '✓');
  assert.equal(steerState(null, now), null);
});

test('steerState reads an epoch-millisecond at, as the server sends it', async () => {
  const { steerState } = await load();
  const now = Date.parse(T('12:00'));
  assert.equal(steerState({ state: 'pending', at: now - 12000 }, now).drainMs, 18000);
});

test('steerMeta words each steer state', async () => {
  const { steerMeta, steerView, clock } = await load();
  const at = T('10:15');
  assert.equal(steerMeta({ state: 'pending', at }), `Your steer from ${clock(at)} is waiting for pickup.`);
  assert.equal(steerMeta({ state: 'delivered', at }), `Steer delivered at ${clock(at)}. Watching for a change.`);
  const failed = { state: 'failed', reason: 'expired', at };
  assert.equal(steerMeta(failed), steerView(failed).word);
  const unclaimed = { state: 'unclaimed', at };
  assert.equal(steerMeta(unclaimed), steerView(unclaimed).word);
  assert.equal(steerMeta(null), '');
});

test('nowView picks waiting, then the first stuck task, then the working line', async () => {
  const { nowView, clock } = await load();
  const waves = [{ n: 1, workers: [stuckWorker(4), stuckWorker(2)] }];
  const since = T('10:30');
  const waiting = nowView({ live: true, now: { state: 'waiting', text: 'x', since }, waves });
  assert.deepEqual(waiting, { glyph: '?', text: 'Waiting for you', since: `since ${clock(since)}`, tone: 'warn' });
  const stuck = nowView({ live: true, now: { state: 'working', text: 'Running', since }, waves });
  assert.equal(stuck.glyph, '!');
  assert.equal(stuck.text, 'Task 2 stuck, STUCK');
  assert.equal(stuck.tone, 'warn');
  const plain = nowView({ live: true, now: { state: 'working', text: 'Running', since }, waves: [{ n: 1, workers: [] }] });
  assert.deepEqual(plain, { glyph: '●', text: 'Running', since: `since ${clock(since)}`, tone: 'live' });
  assert.equal(nowView({ live: true, now: { state: 'working', text: 'Running' }, waves: [] }).since, '');
});

test('nowView names a stuck worker with no task generically', async () => {
  const { nowView } = await load();
  const w = { ...stuckWorker(1), task: null };
  const view = nowView({ live: true, now: { state: 'working', text: 'Running' }, waves: [{ n: 1, workers: [w] }] });
  assert.equal(view.text, 'A worker stuck, STUCK');
});

test('nowView draws a run that is not live with a plain hollow glyph', async () => {
  const { nowView } = await load();
  const view = nowView({ live: false, now: { state: 'idle', text: 'Finished' }, waves: [] });
  assert.equal(view.glyph, '○');
  assert.equal(view.tone, 'plain');
  assert.equal(view.text, 'Finished');
});
