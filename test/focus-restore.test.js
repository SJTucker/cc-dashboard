'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Panels and charts redraw on every 5 s poll and then give focus back to the
// element that had it. A bare focus() scrolls that element into view, so a
// button clicked once pulls the page back to it on each poll.
const DIRS = ['public/panels', 'public/charts'];

test('focus calls in panels and charts pass preventScroll', () => {
  const bare = [];
  for (const dir of DIRS) {
    for (const name of fs.readdirSync(path.join(__dirname, '..', dir))) {
      const file = path.join(dir, name);
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').forEach((line, i) => {
        for (const call of line.matchAll(/\.focus\(([^)]*)\)/g)) {
          if (!call[1].includes('preventScroll: true')) bare.push(`${file}:${i + 1}`);
        }
      });
    }
  }
  assert.deepEqual(bare, []);
});
