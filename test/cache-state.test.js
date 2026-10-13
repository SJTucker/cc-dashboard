'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'bin', 'cache-state');
const HOUR = 60 * 60 * 1000;
const T = Date.UTC(2026, 9, 13, 16, 0, 0);

// One transcript line for an API response. w1h and w5m are cache write tokens by
// lifetime, read the cache read tokens.
function line({ t, id, req, w1h = 0, w5m = 0, read = 0, side = false }) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'abc',
    timestamp: new Date(t).toISOString(),
    requestId: req,
    isSidechain: side,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: w1h + w5m,
        cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m },
      },
    },
  });
}

function transcript(t, lines) {
  const file = path.join(tmpDir(t, 'cache-state'), 'abc.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function run(stdin) {
  return spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });
}

test('cache-state gives the TTL and expiry of the main thread, ignoring sidechain calls and repeated lines', (t) => {
  const file = transcript(t, [
    line({ t: T, id: 'm1', req: 'r1', w1h: 50_000 }),
    line({ t: T, id: 'm1', req: 'r1', w1h: 50_000 }),
    line({ t: T + 60_000, id: 'm2', req: 'r2', read: 50_000 }),
    line({ t: T + 120_000, id: 'm3', req: 'r3', w5m: 1_000, side: true }),
  ]);
  const result = run(JSON.stringify({ transcript: file }));
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { ttl: '1h', expiresAt: T + 60_000 + HOUR });
});

test('cache-state gives a 5m TTL when the last main call wrote a 5-minute cache', (t) => {
  const file = transcript(t, [
    line({ t: T, id: 'm1', req: 'r1', w1h: 50_000 }),
    line({ t: T + 60_000, id: 'm2', req: 'r2', w5m: 50_000 }),
  ]);
  const result = run(JSON.stringify({ transcript: file }));
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { ttl: '5m', expiresAt: T + 60_000 + 5 * 60 * 1000 });
});

test('cache-state prints {} for a missing transcript or one with no main call', (t) => {
  const sideOnly = transcript(t, [line({ t: T, id: 'm1', req: 'r1', w1h: 1_000, side: true })]);
  for (const file of ['/nonexistent/abc.jsonl', sideOnly]) {
    const result = run(JSON.stringify({ transcript: file }));
    assert.strictEqual(result.status, 0, `${file}: ${result.stderr}`);
    assert.deepStrictEqual(JSON.parse(result.stdout), {}, file);
  }
});

test('cache-state exits 1 with a reason for stdin that is not JSON or has no transcript path', () => {
  for (const stdin of ['not json', '', '{}', '{"transcript":3}', 'null']) {
    const result = run(stdin);
    assert.strictEqual(result.status, 1, `stdin ${JSON.stringify(stdin)}`);
    assert.match(result.stderr, /^cache-state: /, `stdin ${JSON.stringify(stdin)}`);
    assert.strictEqual(result.stdout, '', `stdin ${JSON.stringify(stdin)}`);
  }
});
