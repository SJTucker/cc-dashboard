'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

// The mod test runner refuses to import a .json file, so the entries live in
// register.test.ts between two marker comments, as strict JSON.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'mod', 'hooks', 'register.test.ts'), 'utf8');
const CALLS = (() => {
  const where = 'contract block between contract:begin and contract:end in mod/hooks/register.test.ts';
  const begun = SOURCE.split('// contract:begin\n')[1];
  if (begun === undefined || !begun.includes('// contract:end')) throw new Error(`${where} is missing a marker`);
  const block = begun.split('// contract:end')[0];
  try {
    return JSON.parse(block.replace(/^const CONTRACT = /, '').replace(/,\s*\]\s*$/, ']'));
  } catch (err) {
    throw new Error(`${where} is not strict JSON: ${err.message}`);
  }
})();
const PRINTS_JSON = new Set(['judge-updates', 'review-session']);
const PRINTS_NOTHING = new Set(['record-statusline', 'record-session-end']);

const typed = (text) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } });

// A config dir with one ended session ("abc") that has three typed prompts, so
// `review-session prompt` claims it and `review-session record` has something to finish.
function fixture(t) {
  const base = tmpDir(t, 'mod-contract');
  const sessions = path.join(base, 'cc-dashboard', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'abc.json'), JSON.stringify({ sessionId: 'abc', project: 'demo', endedAt: Date.now() }));
  fs.mkdirSync(path.join(base, 'projects', '-work-demo'), { recursive: true });
  fs.writeFileSync(path.join(base, 'projects', '-work-demo', 'abc.jsonl'), ['one', 'two', 'three'].map(typed).join('\n') + '\n');
  return base;
}

test('every call in the contract block of mod/hooks/register.test.ts runs against the real script', (t) => {
  const base = fixture(t);
  assert.ok(CALLS.length >= 6, 'the contract block lists the mod calls');
  for (const call of CALLS) {
    const label = `${call.script} ${call.args.join(' ')}`.trim();
    const input = typeof call.stdin === 'string' ? call.stdin : JSON.stringify(call.stdin);
    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', call.script), ...call.args], {
      input,
      env: { ...process.env, HOME: base, CLAUDE_CONFIG_DIR: base, CHANGES_FILE: path.join(base, 'changes.json'), RTK_DB: path.join(base, 'rtk.db') },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.strictEqual(res.status, 0, `${label} exited ${res.status}: ${res.stderr}`);
    if (PRINTS_JSON.has(call.script)) {
      assert.doesNotThrow(() => JSON.parse(res.stdout), `${label} printed JSON, got ${JSON.stringify(res.stdout)}`);
    }
    if (PRINTS_NOTHING.has(call.script)) {
      assert.strictEqual(res.stdout, '', `${label} must print nothing, because its stdout is the statusline`);
    }
  }
});
