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
