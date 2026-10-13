'use strict';

// A stand-in for document, enough for el() and svgEl() in public/dom.mjs, so
// node:test can check what a DOM builder made. Not a test file: the
// test/*.test.js glob does not run it.
class StubNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.text = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? textNode(n) : n); }
  prepend(...nodes) { this.children.unshift(...nodes.map((n) => (typeof n === 'string' ? textNode(n) : n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener() {}
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(value) { this.children = []; this.text = ''; }
}

function textNode(text) {
  const node = new StubNode('#text');
  node.text = String(text);
  return node;
}

function installDom() {
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag),
    createTextNode: textNode,
  };
}

module.exports = { installDom };
