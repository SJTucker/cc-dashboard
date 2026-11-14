'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');
const { appendEvent, parseEvents, taskOfFile } = require('../lib/orchestrations/events');

const EVENT = path.join(__dirname, '..', 'bin', 'orch-event');

function run(args) {
  return spawnSync(process.execPath, [EVENT, ...args], { encoding: 'utf8' });
}

function runDir(t) {
  const dir = path.join(tmpDir(t, 'events'), 'img.run');
  fs.mkdirSync(dir);
  return dir;
}

function events(dir) {
  return parseEvents(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'));
}

test('appendEvent writes one line with t and the fields given', (t) => {
  const dir = runDir(t);
  appendEvent(dir, { kind: 'merged', task: 2 }, new Date('2026-11-14T10:00:00Z'));
  assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), '{"t":"2026-11-14T10:00:00.000Z","kind":"merged","task":2}\n');
});

test('appendEvent cuts text to 500 characters', (t) => {
  const dir = runDir(t);
  const e = appendEvent(dir, { kind: 'steer', task: 1, text: 'x'.repeat(600) });
  assert.equal(e.text.length, 500);
  assert.equal(events(dir)[0].text.length, 500);
});

test('appendEvent returns null for an unknown kind and writes nothing', (t) => {
  const dir = runDir(t);
  assert.equal(appendEvent(dir, { kind: 'bogus' }), null);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('appendEvent returns null when the folder is missing', (t) => {
  const dir = path.join(tmpDir(t, 'events'), 'nope.run');
  assert.equal(appendEvent(dir, { kind: 'merged', task: 1 }), null);
  assert.equal(fs.existsSync(dir), false);
});

test('parseEvents skips lines that are not events', () => {
  const text = [
    '{"t":"2026-11-14T10:00:00.000Z","kind":"merged","task":1}',
    '{"t":1,"kind":"merged"}',
    'not json',
    '{"t":"2026-11-14T10:00:00.000Z","kind":"nope"}',
    '{"t":"2026-11-14T10:00:00.000Z","kind":"merg',
  ].join('\n');
  const got = parseEvents(text);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'merged');
});

test('taskOfFile reads task and attempt', () => {
  assert.deepEqual(taskOfFile('0003-t7-a2.json'), { task: 7, attempt: 2 });
  assert.equal(taskOfFile('x.json'), null);
});

test('orch-event appends an orchestrator event', (t) => {
  const dir = runDir(t);
  const r = run([dir, 'steer', '--task', '3', '--agent', 'a1', '--text', 'use the stub']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const [e] = events(dir);
  assert.deepEqual({ kind: e.kind, task: e.task, agent: e.agent, text: e.text }, { kind: 'steer', task: 3, agent: 'a1', text: 'use the stub' });
});

test('orch-event creates the run folder', (t) => {
  const dir = path.join(tmpDir(t, 'events'), 'new.run');
  const r = run([dir, 'ready', '--task', '1']);
  assert.equal(r.status, 0, r.stderr);
  const got = events(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'ready');
});

test('orch-event appends a denied event', (t) => {
  const dir = runDir(t);
  const r = run([dir, 'denied', '--agent', 'a1', '--file', '0001-t1-a1.json', '--text', '/code/app/x.js']);
  assert.equal(r.status, 0, r.stderr);
  const [e] = events(dir);
  assert.deepEqual({ kind: e.kind, agent: e.agent, file: e.file, text: e.text }, { kind: 'denied', agent: 'a1', file: '0001-t1-a1.json', text: '/code/app/x.js' });
});

test('orch-event refuses a code-written kind', (t) => {
  const dir = runDir(t);
  const r = run([dir, 'claimed', '--task', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-event: /);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('orch-event without --task exits 1', (t) => {
  const r = run([runDir(t), 'merged']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-event: /);
});

test('orch-event denied without --file exits 1', (t) => {
  const r = run([runDir(t), 'denied', '--agent', 'a1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^orch-event: /);
});
