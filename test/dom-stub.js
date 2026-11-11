'use strict';

// A stand-in for document, enough for el() and svgEl() in public/dom.mjs and for
// the Orchestration tab's renderer, so node:test can check what a DOM builder made.
// It models parents and siblings, dataset (backed by data-* attributes), classList,
// the hidden attribute, event listeners, focus and the few selectors the renderer
// uses. Not a test file: the test/*.test.js glob does not run it.
class StubNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.text = '';
    this.parentNode = null;
    this.value = '';
    this.style = {};
    this._listeners = {};
    const attrs = this.attributes;
    // dataset.key reads and writes the data-key attribute, as in a browser.
    this.dataset = new Proxy({}, {
      get: (_t, key) => attrs[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`],
      set: (_t, key, value) => { attrs[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = String(value); return true; },
      deleteProperty: (_t, key) => { delete attrs[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`]; return true; },
    });
    const node = this;
    this.classList = {
      contains: (name) => node.className.split(/\s+/).includes(name),
      add: (...names) => { for (const n of names) if (!node.classList.contains(n)) node.className = `${node.className} ${n}`.trim(); },
      remove: (...names) => { node.className = node.className.split(/\s+/).filter((c) => c && !names.includes(c)).join(' '); },
      toggle: (name, force) => {
        const on = force === undefined ? !node.classList.contains(name) : Boolean(force);
        if (on) node.classList.add(name);
        else node.classList.remove(name);
        return on;
      },
    };
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  hasAttribute(name) { return name in this.attributes; }
  removeAttribute(name) { delete this.attributes[name]; }
  get hidden() { return 'hidden' in this.attributes; }
  set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; }

  _detach() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  _clear() {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  _insert(child, index) {
    child._detach();
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentNode = this;
    return child;
  }
  appendChild(child) { return this._insert(child, -1); }
  insertBefore(child, ref) { return this._insert(child, ref ? this.children.indexOf(ref) : -1); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? textNode(n) : n); }
  prepend(...nodes) {
    nodes.forEach((n, i) => this._insert(typeof n === 'string' ? textNode(n) : n, i));
  }
  replaceChildren(...nodes) { this._clear(); this.append(...nodes); }
  remove() { this._detach(); }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  // Selectors: ".class", "[attr]", "tag", each optionally after ":scope > " for direct
  // children only.
  _matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[')) return this.hasAttribute(selector.slice(1, -1));
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const direct = selector.startsWith(':scope > ');
    const simple = direct ? selector.slice(9) : selector;
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child._matches(simple)) found.push(child);
        if (!direct) walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  // Runs the listeners of type with a minimal event. Resolves once async listeners
  // settle, and resolves to the event, whose defaultPrevented tells if one prevented.
  async dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    await Promise.all((this._listeners[type] ?? []).map((fn) => fn(event)));
    return event;
  }
  click() { return this.dispatch('click'); }
  requestSubmit() { return this.dispatch('submit'); }
  focus() {
    if (this.hidden) return;
    globalThis.document.activeElement = this;
  }

  set textContent(value) { this._clear(); this.text = String(value); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(value) { this._clear(); this.text = ''; }
}

function textNode(text) {
  const node = new StubNode('#text');
  node.text = String(text);
  return node;
}

function installDom() {
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag),
    createTextNode: textNode,
  };
}

module.exports = { installDom, StubNode };
