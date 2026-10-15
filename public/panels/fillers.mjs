// The two ranked tables under the tool breakdown in the Tool calls panel: What fills
// the context (contextFillers in lib/fillers.js) and Longest turns (longestTurns in
// lib/turns.js). Both come with /api/summary and follow the range picker.
import { el } from '../dom.mjs';
import { formatCost, formatDuration, formatTokens } from '../format.mjs';

const fmt = (n) => n.toLocaleString('en-US');

// A Read, Edit or Write group is an absolute path. The basename is shown and the
// full path goes in the tooltip, as toolRowLabel in public/panels/tools.mjs does.
const groupLabel = (group) => (group.startsWith('/') ? group.split('/').pop() || group : group);

// Sizes are characters of result text. formatTokens gives the same k and M
// abbreviations the rest of the page uses.
export function fillerCells(row) {
  return {
    group: groupLabel(row.group),
    groupTitle: row.group,
    tool: row.tool,
    calls: fmt(row.calls),
    sessions: fmt(row.sessions),
    chars: formatTokens(row.chars),
    median: formatTokens(row.median),
    max: formatTokens(row.max),
    rereads: row.tool === 'Read' ? fmt(row.rereads) : '–',
  };
}

export function turnCells(turn) {
  const start = new Date(turn.start);
  return {
    title: turn.title || turn.sessionId.slice(0, 8),
    started: `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    duration: formatDuration(turn.durationMs),
    calls: fmt(turn.calls),
    cost: formatCost(turn.cost),
  };
}

// A table with a text header row. Column 0 is left-aligned and the rest are numbers,
// except where `left` lists another left-aligned column.
function table(heads, body, left = [0]) {
  const head = el('tr', {}, heads.map((text, i) => el('th', { class: left.includes(i) ? '' : 'num', text })));
  return el('table', { class: 'model-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]);
}

function td(text, cls = 'num', title = null) {
  return el('td', title ? { class: cls, text, title } : { class: cls, text });
}

export function renderContextFillers(fillers) {
  const box = document.getElementById('fillerTable');
  const note = document.getElementById('fillerNote');
  const rows = fillers?.rows || [];
  if (!rows.length) {
    box.replaceChildren();
    note.textContent = 'No tool result sizes in this range. Transcripts Claude Code deleted before sizes were stored have none.';
    return;
  }
  const body = rows.map((row) => {
    const c = fillerCells(row);
    return el('tr', {}, [td(c.group, 'model-name', c.groupTitle), td(c.tool, ''), td(c.calls), td(c.sessions), td(c.chars), td(c.median), td(c.max), td(c.rereads)]);
  });
  box.replaceChildren(table(['Group', 'Tool', 'Calls', 'Sessions', 'Chars', 'Median', 'Largest', 'Re-reads'], body, [0, 1]));
  note.textContent = `${formatTokens(fillers.totals.chars)} characters from ${fmt(fillers.totals.results)} tool results, subagents included.`;
}

export function renderLongestTurns(turns) {
  const box = document.getElementById('turnTable');
  const list = turns || [];
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'panel-note', text: 'No turn durations in this range.' }));
    return;
  }
  const body = list.map((turn) => {
    const c = turnCells(turn);
    return el('tr', {}, [td(c.title, 'model-name', turn.sessionId), td(c.started, ''), td(c.duration), td(c.calls), td(c.cost)]);
  });
  box.replaceChildren(table(['Session', 'Started', 'Duration', 'Calls', 'Cost'], body, [0, 1]));
}
