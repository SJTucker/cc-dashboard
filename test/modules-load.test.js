'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// main.mjs starts the page when it loads, so only a browser can load it. Every
// other module touches no DOM at load time, so node can import it, and an import
// of a name a module does not export fails here instead of on a blank page.
const PUBLIC = path.join(__dirname, '..', 'public');
const modules = fs.readdirSync(PUBLIC, { recursive: true })
  .filter((file) => file.endsWith('.mjs') && file !== 'main.mjs')
  .sort();

test('every public module except main.mjs loads in node', async () => {
  assert.ok(modules.length > 0, 'no module found');
  for (const file of modules) await import(pathToFileURL(path.join(PUBLIC, file)).href);
});

// These modules were classic scripts whose functions other modules used as
// implicit globals. A call to one of their names in a file that does not import it
// is a ReferenceError at run time, and only the code path that makes the call
// shows it, so this test finds those calls statically.
const FORMER_GLOBALS = ['stats', 'layout', 'hud', 'session-groups', 'chart-geometry', 'reviews', 'visibility', 'poll'];

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test('every call to a function from a former classic script is imported in the calling file', async () => {
  const exported = new Map();
  for (const name of FORMER_GLOBALS) {
    const mod = await import(pathToFileURL(path.join(PUBLIC, `${name}.mjs`)).href);
    for (const key of Object.keys(mod)) exported.set(key, `${name}.mjs`);
  }
  const missing = [];
  for (const file of fs.readdirSync(PUBLIC, { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    const code = stripCommentsAndStrings(src);
    const imported = new Set([...src.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())));
    for (const [key, home] of exported) {
      if (file === home) continue;
      const declared = new RegExp(`\\b(?:function|const|let|var)\\s+${key}\\b`).test(code);
      const called = new RegExp(`(?<![.\\w$])${key}\\s*\\(`).test(code);
      if (called && !declared && !imported.has(key)) missing.push(`${file} calls ${key} (from ${home}) without importing it`);
    }
  }
  assert.deepStrictEqual(missing, []);
});
