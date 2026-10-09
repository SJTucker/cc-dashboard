'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SESSION_ID_PATTERN, SESSION_FILE_PATTERN, REVIEW_FILE_PATTERN, PRUNE_AFTER_MS } = require('../lib/session-id');

test('SESSION_ID_PATTERN accepts id characters only, 1 to 128 of them', () => {
  for (const ok of ['abc-123', 'A_b', 'a'.repeat(128)]) assert.ok(SESSION_ID_PATTERN.test(ok), ok);
  for (const bad of ['', '../x', 'a/b', '.', '..', 'a.b', 'a'.repeat(129)]) assert.ok(!SESSION_ID_PATTERN.test(bad), bad);
});

test('SESSION_FILE_PATTERN matches a snapshot and its tmp file, nothing else', () => {
  for (const ok of ['abc.json', 'abc.json.4242']) assert.ok(SESSION_FILE_PATTERN.test(ok), ok);
  for (const bad of ['abc.json.tmp', 'abc.json.4242.tmp', '../abc.json', 'abc.txt', '.json']) {
    assert.ok(!SESSION_FILE_PATTERN.test(bad), bad);
  }
});

test('REVIEW_FILE_PATTERN matches a review file but not a tmp file', () => {
  assert.ok(REVIEW_FILE_PATTERN.test('abc.json'));
  assert.ok(!REVIEW_FILE_PATTERN.test('abc.json.4242'));
});

test('PRUNE_AFTER_MS is one day', () => {
  assert.strictEqual(PRUNE_AFTER_MS, 24 * 60 * 60 * 1000);
});

// The mod cannot require lib/, so it keeps its own copy of the pattern. This test
// fails when either copy changes without the other.
test('the mod accepts the same session ids as lib/session-id.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mod', 'hooks', 'register.ts'), 'utf8');
  const match = src.match(/^const SESSION_ID = \/(.+)\/$/m);
  assert.ok(match, 'register.ts no longer declares `const SESSION_ID = /.../` on one line');
  assert.strictEqual(match[1], SESSION_ID_PATTERN.source);
});
