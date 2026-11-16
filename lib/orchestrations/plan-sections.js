'use strict';

// Cuts one task's sections out of an implementation plan. A worker gets the
// plan's shared sections and its own task section in its claim, instead of
// reading the whole plan.

const SHARED = ['## Global Constraints', '## Review Focus', '## Dependencies'];
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Returns, for each line, whether it sits outside every code fence. A fence
// opens with 3 or more backticks or tildes and closes only with the same
// character, at least as many of them, and nothing after them.
function outsideFences(lines) {
  let open = null;
  return lines.map((line) => {
    const m = FENCE.exec(line);
    if (!open) {
      // CommonMark: a backtick fence's info string holds no backtick.
      const opens = m && !(m[1][0] === '`' && m[2].includes('`'));
      if (opens) open = { char: m[1][0], len: m[1].length };
      return !opens;
    }
    if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === '') open = null;
    return false;
  });
}

// A section runs to the next line outside a fence that starts a heading of
// level 1 or 2, or a task heading. Other ### headings and --- lines stay inside.
const isEnd = (line) => line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### Task ');

function endOf(lines, outside, start) {
  let end = start + 1;
  while (end < lines.length && !(outside[end] && isEnd(lines[end]))) end++;
  while (end > start + 1 && ['', '---'].includes(lines[end - 1].trim())) end--;
  return lines.slice(start, end).join('\n');
}

const splitLines = (text) => text.split(/\r?\n/);

function planSections(planText, task) {
  const lines = splitLines(planText);
  const outside = outsideFences(lines);
  const parts = [];
  for (const heading of SHARED) {
    const start = lines.findIndex((l, i) => outside[i] && l.trimEnd() === heading);
    if (start >= 0) parts.push(endOf(lines, outside, start));
  }
  if (task > 0) {
    const prefix = `### Task ${task}:`;
    const start = lines.findIndex((l, i) => outside[i] && l.startsWith(prefix));
    if (start < 0) return null;
    parts.push(endOf(lines, outside, start));
  }
  return parts.length ? parts.join('\n\n') : null;
}

// Reports which shared headings a plan lacks. missing holds the required ones
// (Global Constraints, Review Focus) with no exact heading line. miscased holds
// any of the three that has no exact heading line but has one that differs in
// case or surrounding space, or adds a suffix such as "## Dependencies:".
function sharedHeadings(planText) {
  const lines = splitLines(planText);
  const outside = outsideFences(lines);
  const norm = (l) => l.trim().toLowerCase();
  const has = (name, same) => lines.some((l, i) => outside[i] && same(l, '## ' + name));
  const exact = (name) => has(name, (l, h) => l.trimEnd() === h);
  const loose = (name) => has(name, (l, h) => norm(l).startsWith(norm(h)));
  const names = SHARED.map((h) => h.slice(3));
  return {
    missing: names.slice(0, 2).filter((n) => !exact(n)),
    miscased: names.filter((n) => !exact(n) && loose(n)),
  };
}

// Returns the N of each "### Task N:" heading outside a fence, in plan order.
function planTasks(planText) {
  const lines = splitLines(planText);
  const outside = outsideFences(lines);
  const tasks = [];
  lines.forEach((l, i) => {
    const m = outside[i] && /^### Task (\d+):/.exec(l);
    if (m) tasks.push(Number(m[1]));
  });
  return tasks;
}

// Returns each "## " heading line outside a fence that no excerpt carries: any
// heading that is not a shared one, and a shared heading after its first
// occurrence, because planSections copies only the first. A sections worker
// never sees these sections.
function otherSections(planText) {
  const lines = splitLines(planText);
  const outside = outsideFences(lines);
  const seen = new Set();
  const carried = (h) => {
    if (!SHARED.includes(h) || seen.has(h)) return false;
    seen.add(h);
    return true;
  };
  return lines.filter((l, i) => outside[i] && l.startsWith('## ')).map((l) => l.trimEnd()).filter((h) => !carried(h));
}

module.exports = { planSections, sharedHeadings, planTasks, otherSections };
