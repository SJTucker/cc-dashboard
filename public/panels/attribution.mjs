// Where usage goes: main thread against subagents, over against under the context
// threshold, and the skill and subagent lists.
import { formatCost, axisTokens, escapeHtml } from '../format.mjs';
import { shown } from '../state.mjs';
import { drawSplitBar } from '../charts/split.mjs';
import { drawHBars } from '../charts/hbars.mjs';

// A skill or subagent row's share of total cost, such as "4.3%".
function shareOfTotal(row, totalCost) {
  return `${(totalCost > 0 ? (row.cost / totalCost) * 100 : 0).toFixed(1)}%`;
}

// A skill or subagent row's text: the times it was invoked in the range, then its
// share of total cost, such as "21× · 4.3%". row.invocations comes from aggregate in
// lib/aggregate.js: Skill tool calls and slash commands for a skill, Agent tool calls
// for a subagent type.
export function usageValue(row, totalCost) {
  return `${row.invocations.toLocaleString('en-US')}× · ${shareOfTotal(row, totalCost)}`;
}

function invokedLine(n) {
  if (n === 0) return 'Not invoked in this range';
  return `Invoked ${n === 1 ? 'once' : `${n.toLocaleString('en-US')} times`} in this range`;
}

// The name is escaped because the tooltip is assigned as HTML (barNode in
// charts/hbars.mjs).
export function usageTooltip(row, totalCost) {
  return `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${shareOfTotal(row, totalCost)} of total`
    + `<br>${invokedLine(row.invocations)}`;
}

export function renderAttribution(data) {
  const totalCost = data.summary.totalCost;
  document.getElementById('attributionPanel').hidden = totalCost <= 0;
  if (!shown('attribution')) return;
  // The skill and subagent lists share one scale. On separate scales a 30.8%
  // subagent bar drew longer than a 68.2% thread bar. The two split bars scale
  // themselves.
  const attributionScale = [...data.skills, ...data.subagents].reduce((max, r) => Math.max(max, r.cost), 0);
  // Skill and subagent rows: the bar against the shared scale, the text the
  // invocations and the true share of total cost. usage-count widens the text cell
  // to fit both, so the bars of one list line up.
  const usageBars = {
    size: (row) => row.cost,
    scaleMax: attributionScale,
    value: (row) => usageValue(row, totalCost),
    tooltip: (row) => usageTooltip(row, totalCost),
    valueClass: 'usage-pct usage-count',
    empty: 'Nothing attributed in this range.',
  };
  const threadRows = [
    { name: 'Main thread', cost: data.threads.main },
    { name: 'Subagents', cost: data.threads.subagent },
  ];
  const contextRows = [
    { name: `Over ${axisTokens(data.contextThreshold)} context`, cost: data.context.over },
    { name: `Under ${axisTokens(data.contextThreshold)} context`, cost: data.context.under },
  ];
  drawSplitBar(document.getElementById('threadBars'), threadRows);
  drawSplitBar(document.getElementById('contextBars'), contextRows);
  drawHBars(document.getElementById('skillBars'), data.skills.slice(0, 8), usageBars);
  drawHBars(document.getElementById('subagentBars'), data.subagents.slice(0, 8), usageBars);
}
