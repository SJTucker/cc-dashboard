'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'bin', 'cache-line');

// Runs the script the way a statusline script does, from a folder other than the
// repo, with `stdin` piped in. CLAUDE_CONFIG_DIR points at configDir, so the saved
// cache state never lands in the real ~/.claude.
function run(stdin, configDir) {
  return spawnSync(SCRIPT, [], { input: stdin, cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
}

const cacheDir = (configDir) => path.join(configDir, 'cc-dashboard', 'cache');

test('cache-line prints the cache line for a warm cache', (t) => {
  const configDir = tmpDir(t, 'cache-line');
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
  const result = run(JSON.stringify({
    model: { id: 'claude-opus-5-5' },
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: expiresAt, recache_tokens_if_cold: 100_000 },
  }), configDir);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^cache (29|30) min left · rebuild \$0\.78\n$/);
  assert.strictEqual(result.stderr, '');
  assert.strictEqual(fs.existsSync(cacheDir(configDir)), false);
});

test('cache-line prints nothing and exits 0 without prompt_cache', (t) => {
  const configDir = tmpDir(t, 'cache-line');
  const result = run(JSON.stringify({ model: { id: 'claude-opus-5-5' } }), configDir);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(fs.existsSync(cacheDir(configDir)), false);
});

test('cache-line prints nothing and exits 0 for bad or empty stdin', (t) => {
  const configDir = tmpDir(t, 'cache-line');
  for (const stdin of ['not json', '', '{"prompt_cache":']) {
    const result = run(stdin, configDir);
    assert.strictEqual(result.status, 0, `stdin ${JSON.stringify(stdin)}`);
    assert.strictEqual(result.stdout, '', `stdin ${JSON.stringify(stdin)}`);
    assert.strictEqual(result.stderr, '', `stdin ${JSON.stringify(stdin)}`);
  }
  assert.strictEqual(fs.existsSync(cacheDir(configDir)), false);
});

const WARM_1H = (sessionId) => ({
  session_id: sessionId,
  model: { id: 'claude-opus-5-5' },
  prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: Math.floor(Date.now() / 1000) + 30 * 60, recache_tokens_if_cold: 100_000 },
});

test("cache-line saves the session's cache expiry under cc-dashboard/cache", (t) => {
  const configDir = tmpDir(t, 'cache-line');
  const input = WARM_1H('s1');
  const result = run(JSON.stringify(input), configDir);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^cache (29|30) min left · rebuild \$0\.78\n$/);
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir(configDir), 's1.json'), 'utf8'));
  assert.strictEqual(saved.ttl, '1h');
  assert.strictEqual(saved.expiresAt, input.prompt_cache.expires_at * 1000);
});

test('cache-line prints its line and exits 0 when the cache folder cannot be written', (t) => {
  const configDir = tmpDir(t, 'cache-line');
  fs.writeFileSync(path.join(configDir, 'cc-dashboard'), 'not a folder');
  const result = run(JSON.stringify(WARM_1H('s1')), configDir);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^cache (29|30) min left · rebuild \$0\.78\n$/);
  assert.strictEqual(result.stderr, '');
});
