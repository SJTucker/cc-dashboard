'use strict';

const test = require('node:test');
const helpers = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getActivityDir, readActivity, resolveActivity, STALE_AFTER_MS } = require('../lib/activity');

// Real time: readActivity prunes by comparing a file's mtime, which is the real clock, with now.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function tmpDir() {
  return helpers.tmpDir(null, 'activity');
}

function activity(overrides = {}) {
  return {
    sessionId: 's1',
    state: 'working',
    since: NOW - 30_000,
    tool: { name: 'Bash', detail: 'npm test', startedAt: NOW - 20_000 },
    subagents: 2,
    updatedAt: NOW - 10_000,
    ...overrides,
  };
}

function write(dir, a, name = `${a.sessionId}.json`) {
  fs.writeFileSync(path.join(dir, name), typeof a === 'string' ? a : JSON.stringify(a));
}

test('getActivityDir follows CLAUDE_CONFIG_DIR, expanding a leading ~, else ~/.claude', (t) => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });
  process.env.CLAUDE_CONFIG_DIR = '/cfg';
  assert.strictEqual(getActivityDir(), path.join('/cfg', 'cc-dashboard', 'activity'));
  process.env.CLAUDE_CONFIG_DIR = '~/cfg';
  assert.strictEqual(getActivityDir(), path.join(os.homedir(), 'cfg', 'cc-dashboard', 'activity'));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.strictEqual(getActivityDir(), path.join(os.homedir(), '.claude', 'cc-dashboard', 'activity'));
});

test('readActivity returns a map keyed by session id', () => {
  const dir = tmpDir();
  write(dir, activity());
  const map = readActivity(dir, NOW);
  assert.deepStrictEqual([...map.keys()], ['s1']);
  assert.deepStrictEqual(map.get('s1'), activity());
});

test('readActivity skips unreadable, wrong-shaped and unknown-state files', () => {
  const dir = tmpDir();
  write(dir, activity({ sessionId: 'good' }));
  write(dir, '{"sessionId":"half","state":"work', 'half.json');
  write(dir, { sessionId: 'x' }, 'wrong-shape.json');
  write(dir, activity({ sessionId: 'odd', state: 'sleeping' }));
  write(dir, activity({ sessionId: 'approval', state: 'approval' }));
  write(dir, activity({ sessionId: 'no-time', updatedAt: 'now' }));
  write(dir, activity({ sessionId: 'bad id!' }), 'bad-id.json');
  write(dir, activity({ sessionId: 'tmp' }), 'tmp.json.123');
  write(dir, '[]', 'array.json');
  assert.deepStrictEqual([...readActivity(dir, NOW).keys()], ['good']);
});

test('readActivity treats a malformed tool as no tool and a bad subagent count as 0', () => {
  const dir = tmpDir();
  write(dir, activity({ sessionId: 'a', tool: { name: 5 }, subagents: -1 }));
  write(dir, activity({ sessionId: 'b', tool: { name: 'Read', startedAt: NOW - 1 }, subagents: 'two' }));
  const map = readActivity(dir, NOW);
  assert.deepStrictEqual([map.get('a').tool, map.get('a').subagents], [null, 0]);
  assert.deepStrictEqual(map.get('b').tool, { name: 'Read', detail: '', startedAt: NOW - 1 });
  assert.strictEqual(map.get('b').subagents, 0);
});

test('readActivity returns an empty map when the directory does not exist', () => {
  assert.strictEqual(readActivity(path.join(tmpDir(), 'none'), NOW).size, 0);
});

test('readActivity skips a file last updated over 24h ago and deletes it when its mtime is that old', () => {
  const dir = tmpDir();
  write(dir, activity({ sessionId: 'old', updatedAt: NOW - DAY - 1000 }));
  write(dir, activity({ sessionId: 'recent' }));
  write(dir, '{}', 'notes.txt');
  fs.writeFileSync(path.join(dir, 'other.json.bak'), 'x');
  const old = (NOW - DAY - 60_000) / 1000;
  for (const name of ['old.json', 'notes.txt', 'other.json.bak']) fs.utimesSync(path.join(dir, name), old, old);
  assert.deepStrictEqual([...readActivity(dir, NOW).keys()], ['recent']);
  assert.ok(!fs.existsSync(path.join(dir, 'old.json')), 'old.json is pruned');
  assert.ok(fs.existsSync(path.join(dir, 'recent.json')), 'recent.json stays');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'a name this module does not write stays');
  assert.ok(fs.existsSync(path.join(dir, 'other.json.bak')), 'a name this module does not write stays');
});

test('resolveActivity drops working that was last updated over 10 minutes ago', () => {
  assert.strictEqual(resolveActivity(activity({ updatedAt: NOW - STALE_AFTER_MS - 1 }), NOW), null);
  assert.notStrictEqual(resolveActivity(activity({ updatedAt: NOW - STALE_AFTER_MS }), NOW), null);
});

test('resolveActivity keeps waiting however old, and returns only the display fields', () => {
  const a = activity({ state: 'waiting', tool: null, subagents: 0, updatedAt: NOW - 5 * 60 * 60 * 1000 });
  assert.deepStrictEqual(resolveActivity(a, NOW), { state: 'waiting', since: a.since, tool: null, subagents: 0 });
  assert.strictEqual(resolveActivity(undefined, NOW), null);
});

test('resolveActivity reports waiting with running subagents as working', () => {
  const a = activity({ state: 'waiting', tool: null, subagents: 2 });
  assert.deepStrictEqual(resolveActivity(a, NOW), { state: 'working', since: a.since, tool: null, subagents: 2 });
});

test('resolveActivity reports stale waiting with subagents as waiting with no subagents', () => {
  // A killed subagent leaves its count in the file, and the main loop still waits on the user.
  const old = activity({ state: 'waiting', tool: null, subagents: 2, updatedAt: NOW - 3 * 60 * 60 * 1000 });
  assert.deepStrictEqual(resolveActivity(old, NOW), { state: 'waiting', since: old.since, tool: null, subagents: 0 });
  const justStale = activity({ state: 'waiting', tool: null, subagents: 2, updatedAt: NOW - STALE_AFTER_MS - 1 });
  assert.deepStrictEqual(resolveActivity(justStale, NOW), { state: 'waiting', since: justStale.since, tool: null, subagents: 0 });
  const fresh = activity({ state: 'waiting', tool: null, subagents: 2, updatedAt: NOW - STALE_AFTER_MS });
  assert.deepStrictEqual(resolveActivity(fresh, NOW), { state: 'working', since: fresh.since, tool: null, subagents: 2 });
});
