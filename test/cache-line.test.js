'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'bin', 'cache-line');

// Runs the script the way a statusline script does, from a folder other than the
// repo, with `stdin` piped in.
function run(stdin) {
  return spawnSync(SCRIPT, [], { input: stdin, cwd: os.tmpdir(), encoding: 'utf8' });
}

test('cache-line prints the cache line for a warm cache', () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
  const result = run(JSON.stringify({
    model: { id: 'claude-opus-5-5' },
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: expiresAt, recache_tokens_if_cold: 100_000 },
  }));
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^cache (29|30) min left · rebuild \$0\.78\n$/);
  assert.strictEqual(result.stderr, '');
});

test('cache-line prints nothing and exits 0 without prompt_cache', () => {
  const result = run(JSON.stringify({ model: { id: 'claude-opus-5-5' } }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});

test('cache-line prints nothing and exits 0 for bad or empty stdin', () => {
  for (const stdin of ['not json', '', '{"prompt_cache":']) {
    const result = run(stdin);
    assert.strictEqual(result.status, 0, `stdin ${JSON.stringify(stdin)}`);
    assert.strictEqual(result.stdout, '', `stdin ${JSON.stringify(stdin)}`);
    assert.strictEqual(result.stderr, '', `stdin ${JSON.stringify(stdin)}`);
  }
});
