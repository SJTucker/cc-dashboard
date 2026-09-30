'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { orderRowKeys } = require('../public/layout');

test('with no saved order the default order comes back as a new array', () => {
  const defaults = ['a', 'b', 'c'];
  const result = orderRowKeys(defaults, null);
  assert.deepStrictEqual(result, ['a', 'b', 'c']);
  assert.notStrictEqual(result, defaults);
});

test('a saved order that lists every row is used as it is', () => {
  assert.deepStrictEqual(orderRowKeys(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('a saved key with no matching row is dropped', () => {
  assert.deepStrictEqual(orderRowKeys(['a', 'b', 'c'], ['c', 'gone', 'a', 'b']), ['c', 'a', 'b']);
});

test('a row missing from the saved order goes after the row before it in the default order', () => {
  assert.deepStrictEqual(orderRowKeys(['a', 'b', 'c', 'd'], ['c', 'a', 'd']), ['c', 'a', 'b', 'd']);
});

test('a row missing from the saved order goes first when it is first in the default order', () => {
  assert.deepStrictEqual(orderRowKeys(['new', 'a', 'b'], ['b', 'a']), ['new', 'b', 'a']);
});

test('two missing rows in a row keep their default order after their predecessor', () => {
  assert.deepStrictEqual(orderRowKeys(['a', 'n1', 'n2', 'b'], ['b', 'a']), ['b', 'a', 'n1', 'n2']);
});

test('a duplicate saved key counts once, at its first position', () => {
  assert.deepStrictEqual(orderRowKeys(['a', 'b', 'c'], ['b', 'b', 'a', 'c']), ['b', 'a', 'c']);
});

test('a saved value that is not a list of strings gives the default order', () => {
  for (const saved of ['a,b,c', {}, 42, [1, 2], ['a', null], undefined]) {
    assert.deepStrictEqual(orderRowKeys(['a', 'b', 'c'], saved), ['a', 'b', 'c']);
  }
});
