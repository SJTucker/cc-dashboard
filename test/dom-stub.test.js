'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installDom } = require('./dom-stub.js');

function parentWithThree() {
  installDom();
  const p = document.createElement('div');
  for (let i = 0; i < 3; i++) {
    const c = document.createElement('div');
    c.className = 'a';
    p.appendChild(c);
  }
  return p;
}

test('querySelectorAll has no array methods', () => {
  const found = parentWithThree().querySelectorAll('.a');
  assert.equal(Array.isArray(found), false);
  assert.equal(found.find, undefined);
  assert.equal(found.map, undefined);
  assert.equal(found.filter, undefined);
  assert.equal(found.length, 3);
  assert.equal(found[0], found.item(0));
  assert.equal([...found].length, 3);
  let calls = 0;
  found.forEach(() => { calls++; });
  assert.equal(calls, 3);
  assert.deepEqual([...found.keys()], [0, 1, 2]);
  assert.equal([...found.values()].length, 3);
  assert.equal([...found.entries()].length, 3);
});

test('children is an HTMLCollection shape', () => {
  const p = parentWithThree();
  assert.equal(Array.isArray(p.children), false);
  assert.equal(p.children.forEach, undefined);
  assert.equal(p.children.find, undefined);
  assert.equal(p.children.length, 3);
  assert.equal(p.children[1], p.children.item(1));
  assert.equal([...p.children].length, 3);
});

test('querySelector returns the first match or null', () => {
  const p = parentWithThree();
  assert.equal(p.querySelector('.a'), p.children[0]);
  assert.equal(p.querySelector('.missing'), null);
});

test('tree edits still work', () => {
  const p = parentWithThree();
  const [a, b, c] = [...p.children];
  const x = document.createElement('span');
  p.insertBefore(x, b);
  assert.equal(a.nextSibling, x);
  const y = document.createElement('i');
  p.prepend(y);
  assert.equal(p.firstChild, y);
  y.remove();
  assert.equal(p.firstChild, a);
  c.textContent = 'hi';
  assert.equal(p.textContent, 'hi');
  p.replaceChildren(b);
  assert.equal(p.children.length, 1);
  assert.equal(p.children[0], b);
});

test('a held children value is a snapshot', () => {
  const p = parentWithThree();
  const held = p.children;
  p.children[0].remove();
  assert.equal(held.length, 3);
  assert.equal([...held].length, 3);
  assert.notEqual(held.item(2), null);
});
