// The Tool calls panel: calls per tool, the breakdown of the selected tool, and
// its errors.
import { el } from '../dom.mjs';
import { escapeHtml } from '../format.mjs';
import { drawHBars } from '../charts/hbars.mjs';
import { DETAIL_LIMIT } from '../constants.mjs';
import { segmentTexture } from '../charts/palette.mjs';

// Which error causes the model table counts. The names must equal causes in
// ERROR_CAUSES in lib/aggregate.js (test/tools-panel.test.js checks them). A
// "tool misused" error is the model's own mistake. A failed command is often
// expected, such as a failing test or a grep with no match, so it gets a second
// rate. Every other cause comes from the environment and is not counted.
export const MISTAKE_CAUSES = ['tool misused'];
export const FAILED_CAUSES = ['command failed'];
// Below this many calls a rate swings on one error, so the row shows counts only.
export const MIN_RATE_CALLS = 20;
// The name of the total entry from lib/aggregate.js, also used as selectedTool
// when that entry is chosen.
export const ALL_TOOLS = 'All tools';

const fmt = (n) => n.toLocaleString('en-US');

// The figures in one row of the model table.
export function modelErrorCells(row) {
  const sum = (causes) => row.errorCauses.filter((c) => causes.includes(c.cause)).reduce((n, c) => n + c.count, 0);
  const mistakes = sum(MISTAKE_CAUSES);
  const failed = sum(FAILED_CAUSES);
  const rated = row.calls >= MIN_RATE_CALLS;
  const rate = (n) => (rated ? `${((n / row.calls) * 100).toFixed(1)}%` : '–');
  const counted = [...MISTAKE_CAUSES, ...FAILED_CAUSES];
  return {
    mistakes: rate(mistakes),
    withFailed: rate(mistakes + failed),
    notCounted: row.errors - mistakes - failed,
    countsTitle: `${fmt(mistakes)} misused and ${fmt(failed)} failed commands in ${fmt(row.calls)} calls`
      + (rated ? '' : `. Fewer than ${MIN_RATE_CALLS} calls, so no rate.`),
    notCountedTitle: row.errorCauses.filter((c) => !counted.includes(c.cause)).map((c) => `${c.cause}: ${fmt(c.count)}`).join('\n'),
  };
}

// Which entry the right column shows. `toolTotals` is missing when the page is
// newer than the server process, and then All tools is not offered.
export function toolSelection(tools, toolTotals, selected) {
  const all = toolTotals && toolTotals.calls ? toolTotals : null;
  if (selected === ALL_TOOLS && all) return { selected, current: all, all };
  const current = tools.find((t) => t.name === selected) || tools[0];
  return { selected: current.name, current, all };
}

// One row per model. The label beside the swatch carries the model's identity, so
// colour is never the only cue.
function renderModelTable(entry) {
  const box = document.getElementById('toolModelTable');
  const models = entry.byModel || [];
  box.replaceChildren();
  box.hidden = !models.length;
  if (!models.length) return;
  const head = el('tr', {}, ['Model', 'Calls', 'Mistakes', '+ failed commands', 'Not counted']
    .map((text, i) => el('th', { class: i ? 'num' : '', text })));
  const body = models.map((row) => {
    const cells = modelErrorCells(row);
    return el('tr', {}, [
      el('td', { class: 'model-name' }, [el('span', { class: 'swatch', style: segmentTexture(row.family) }), document.createTextNode(row.label)]),
      el('td', { class: 'num', text: fmt(row.calls) }),
      el('td', { class: 'num', text: cells.mistakes, title: cells.countsTitle }),
      el('td', { class: 'num', text: cells.withFailed, title: cells.countsTitle }),
      el('td', { class: 'num', text: fmt(cells.notCounted), title: cells.notCountedTitle }),
    ]);
  });
  box.appendChild(el('table', { class: 'model-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]));
}

// A detail row for Read, Write or Edit is an absolute file path. The name cell
// truncates from the right, which on a path shows the part every row has in common,
// so the basename is displayed and the full path goes in the tooltip.
function toolRowLabel(name) {
  return name.startsWith('/') ? name.split('/').pop() || name : name;
}

// Which tool the detail column is showing, or ALL_TOOLS when the total entry is
// chosen. Held across renders so a range switch or a live poll does not throw the
// reader back to the first tool; it falls back to the busiest tool when the
// selected one has no calls in the new range.
let selectedTool = null;

// Name of the tool renderToolErrors last drew the error list for. A 5s poll on the
// Today range calls renderToolErrors again for the same tool and must not close a
// group the reader opened; clicking a different tool in the bars above is a real
// change of subject and starts closed. Paired with errorGroupKey below, which is
// stored on each <details> so a rebuilt element can be matched back to its group.
let toolErrorsFor = null;

function errorGroupKey(g) {
  return `${g.cause}\n${g.message}`;
}

// The keys of currently open groups, or an empty set when the tool just changed.
// A poll rebuilds the whole list every time (see renderToolErrors), so "open" has
// to be read off the DOM before the old elements are replaced.
function openErrorKeys(list, tool) {
  if (toolErrorsFor !== tool.name) {
    toolErrorsFor = tool.name;
    return new Set();
  }
  return new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.key));
}

// Error text comes from tool results on disk, so it only ever reaches the page
// through textContent. Each group is a <details> so the full example opens on
// click or keyboard, which a hover tooltip cannot do on a touch screen.
function renderToolErrors(tool) {
  const title = document.getElementById('toolErrorTitle');
  const causes = document.getElementById('toolErrorCauses');
  const list = document.getElementById('toolErrorList');
  const openKeys = openErrorKeys(list, tool);
  causes.replaceChildren();
  list.replaceChildren();
  title.hidden = !tool.errors;
  if (!tool.errors) return;

  title.textContent = `Errors · ${tool.errors.toLocaleString('en-US')}`;
  for (const { cause, count } of tool.errorCauses) {
    causes.appendChild(el('span', { class: 'error-cause' }, [
      document.createTextNode(cause),
      el('b', { text: count.toLocaleString('en-US') }),
    ]));
  }
  for (const g of tool.errorGroups) {
    const key = errorGroupKey(g);
    const summary = el('summary', {}, [
      el('span', { class: 'error-count', text: g.count.toLocaleString('en-US') }),
      el('span', { class: 'error-message', text: g.message }),
    ]);
    const when = el('div', { class: 'error-when', text: `${g.cause} · latest ${new Date(g.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
    const group = el('details', { class: 'error-group', 'data-key': key }, [summary, when, el('pre', { class: 'error-example', text: g.example })]);
    group.open = openKeys.has(key);
    list.appendChild(group);
  }
  const shown = tool.errorGroups.reduce((n, g) => n + g.count, 0);
  if (shown < tool.errors) {
    list.appendChild(el('div', { class: 'panel-note', text: `${(tool.errors - shown).toLocaleString('en-US')} more in smaller groups.` }));
  }
}

// How the tool lists draw a row: call counts, with the error rate beside a tool
// that had errors.
const TOOL_BARS = {
  size: (row) => row.calls,
  label: (row) => toolRowLabel(row.name),
  value: (row) => (row.errors
    ? `${row.calls.toLocaleString('en-US')} · ${((row.errors / row.calls) * 100).toFixed(1)}% err`
    : row.calls.toLocaleString('en-US')),
  tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${row.calls.toLocaleString('en-US')} calls`
    + (row.errors ? `<br>${row.errors.toLocaleString('en-US')} returned an error` : ''),
  valueClass: 'usage-pct usage-count',
  empty: 'No tool calls in this range.',
};

export function renderTools(tools, toolTotals) {
  const panel = document.getElementById('toolPanel');
  panel.hidden = !tools.length;
  if (!tools.length) return;

  const pick = toolSelection(tools, toolTotals, selectedTool);
  selectedTool = pick.selected;
  const { current, all } = pick;
  const select = (name) => {
    selectedTool = name;
    renderTools(tools, toolTotals);
  };

  const allBox = document.getElementById('toolAll');
  allBox.hidden = !all;
  if (all) drawHBars(allBox, [all], { ...TOOL_BARS, scaleMax: all.calls, onSelect: select, selectedName: selectedTool });

  const shown = tools.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('toolBars'), shown, {
    ...TOOL_BARS,
    scaleMax: Math.max(...shown.map((t) => t.calls)),
    onSelect: select,
    selectedName: selectedTool,
  });

  renderToolDetails(current, current === all);
  renderToolErrors(current);
  renderModelTable(current);
}

// The total entry has no breakdown of its own: its breakdown is the tool list.
function renderToolDetails(current, isAll) {
  const bars = document.getElementById('toolDetailBars');
  const note = document.getElementById('toolDetailNote');
  document.getElementById('toolDetailTitle').textContent = isAll ? ALL_TOOLS : `Inside ${toolRowLabel(current.name)}`;
  bars.hidden = isAll;
  note.hidden = isAll;
  if (isAll) return;
  drawHBars(bars, current.details, {
    ...TOOL_BARS,
    scaleMax: current.details.length ? Math.max(...current.details.map((d) => d.calls)) : 0,
  });
  note.textContent = current.details.length ? '' : 'No breakdown for this tool.';
}
