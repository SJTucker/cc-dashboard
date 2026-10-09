// Where usage goes: main thread against subagents, over against under the context
// threshold, and the skill and subagent lists.
import { formatCost, axisTokens, escapeHtml } from '../format.mjs';
import { shown } from '../state.mjs';
import { drawSplitBar } from '../charts/split.mjs';
import { drawHBars } from '../charts/hbars.mjs';

export function renderAttribution(data) {
  const totalCost = data.summary.totalCost;
  document.getElementById('attributionPanel').hidden = totalCost <= 0;
  if (!shown('attribution')) return;
  // Every bar in the panel shares one scale. Groups on separate scales made a
  // 30.8% subagent bar draw longer than a 68.2% thread bar.
  // The two split bars are self-scaling, so only the skill and subagent lists
  // share this one, which is what keeps their lengths comparable to each other.
  const attributionScale = [...data.skills, ...data.subagents].reduce((max, r) => Math.max(max, r.cost), 0);
  // Skill and subagent rows: the bar against the shared scale, the text the true
  // share of total cost.
  const shareOfTotal = (row) => `${(totalCost > 0 ? (row.cost / totalCost) * 100 : 0).toFixed(1)}%`;
  const usageBars = {
    size: (row) => row.cost,
    scaleMax: attributionScale,
    value: shareOfTotal,
    tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${formatCost(row.cost)} &middot; ${shareOfTotal(row)} of total`,
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
