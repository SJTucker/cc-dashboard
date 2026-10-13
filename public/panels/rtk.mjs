// The rtk panels: tokens rtk kept out of the model's context per day, and per command.
import { formatTokens, fullDate, escapeHtml } from '../format.mjs';
import { shown } from '../state.mjs';
import { drawBarChart } from '../charts/bar.mjs';
import { drawHBars } from '../charts/hbars.mjs';
import { DETAIL_LIMIT } from '../constants.mjs';

// rtk figures are deliberately not folded into any summary card. They estimate
// command output that never reached the model's context, in rtk's own tokens of 4
// characters; the cards above count tokens Anthropic billed. Adding one to the
// other would produce a number that means nothing. lib/rtk.js has the estimate.
// Held across renders so a range switch or a live poll does not move the reader
// back to the first command.
let selectedRtkCommand = null;

// The estimate first, then rtk's own figures for comparison.
const figureLines = (row) =>
  `${formatTokens(row.keptOut)} kept out of context`
  + `<br>${formatTokens(row.filtered)} filtered from ${formatTokens(row.raw)} raw`;

// How the rtk lists draw a row: scaled by tokens kept out of context rather than by
// call count, because "which commands is rtk helping with" is a question about
// tokens. A command whose rtk output put more into context than it kept out has a
// negative figure and draws left of zero.
const RTK_BARS = {
  size: (row) => row.keptOut,
  value: (row) => formatTokens(row.keptOut),
  tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${figureLines(row)}`
    + `<br>${row.calls.toLocaleString('en-US')} ${row.calls === 1 ? 'call' : 'calls'}`,
  valueClass: 'usage-pct usage-count',
  empty: 'No rtk commands in this range.',
};

// Both ends of a list's scale. scaleMin stays 0 unless a row is negative.
const scaleOf = (rows) => ({
  scaleMax: Math.max(...rows.map((r) => r.keptOut), 0),
  scaleMin: Math.min(...rows.map((r) => r.keptOut), 0),
});

// The DETAIL_LIMIT commands with the largest |keptOut|, shown largest first. Ranking by
// magnitude keeps a negative command, which sorts last, from falling off the list.
export function commandRows(commands) {
  return [...commands]
    .sort((a, b) => Math.abs(b.keptOut) - Math.abs(a.keptOut))
    .slice(0, DETAIL_LIMIT)
    .sort((a, b) => b.keptOut - a.keptOut);
}

// The selected row of the shown list, or its first row when the selection is not in
// it: a range change can move the stored command out of the shown DETAIL_LIMIT.
export function pickCommand(rows, name) {
  return rows.find((c) => c.name === name) || rows[0];
}

function renderRtkCommands(commands) {
  const shown = commandRows(commands);
  const current = pickCommand(shown, selectedRtkCommand);
  selectedRtkCommand = current.name;

  drawHBars(document.getElementById('rtkCommandBars'), shown, {
    ...RTK_BARS,
    ...scaleOf(shown),
    onSelect: (name) => {
      selectedRtkCommand = name;
      renderRtkCommands(commands);
    },
    selectedName: selectedRtkCommand,
  });

  document.getElementById('rtkDetailTitle').textContent = `Inside rtk ${current.name}`;
  const details = current.details.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('rtkDetailBars'), details, { ...RTK_BARS, ...scaleOf(details) });
}

export function renderRtk(rtk) {
  const live = Boolean(rtk && rtk.meta.dbExists);

  const dailyPanel = document.getElementById('rtkDailyPanel');
  const hasDaily = live && rtk.daily.some((d) => d.keptOut !== 0);
  dailyPanel.hidden = !hasDaily;
  if (hasDaily && shown('rtkDaily')) {
    drawBarChart(document.getElementById('rtkDailyChart'), rtk.daily, {
      // Single series that is not money: no legend, and the slate series colour.
      color: 'var(--series-neutral)',
      valueKey: 'keptOut',
      tooltipFn: (d) =>
        `<b>${fullDate(d.date)}</b><br>${figureLines(d)}`
        + `<br>${d.commands.toLocaleString('en-US')} ${d.commands === 1 ? 'command' : 'commands'}`,
    });
  }

  const cmdPanel = document.getElementById('rtkCommandPanel');
  const withFigure = live ? rtk.commands.filter((c) => c.keptOut !== 0) : [];
  cmdPanel.hidden = !withFigure.length;
  if (withFigure.length && shown('rtkCommands')) renderRtkCommands(withFigure);
}
