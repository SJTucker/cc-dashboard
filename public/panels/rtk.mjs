// The rtk panels: tokens rtk filtered per day, and per command.
import { formatTokens, fullDate, escapeHtml } from '../format.mjs';
import { shown } from '../state.mjs';
import { drawBarChart } from '../charts/bar.mjs';
import { drawHBars } from '../charts/hbars.mjs';
import { DETAIL_LIMIT } from '../constants.mjs';

// rtk figures are deliberately not folded into any summary card. They count output
// bytes rtk filtered before the text reached the model, estimated by rtk's own
// tokeniser; the cards above count tokens Anthropic billed. Adding one to the other
// would produce a number that means nothing.
// Held across renders for the same reason selectedTool is: a range switch or a live
// poll should not throw the reader back to the first command.
let selectedRtkCommand = null;

// How the rtk lists draw a row: scaled by tokens saved rather than by call count,
// because "which commands is rtk helping with" is a question about tokens. A
// command with 15,000 cheap calls and one with 127 expensive ones both show up
// honestly this way.
const RTK_BARS = {
  size: (row) => row.saved,
  value: (row) => formatTokens(row.saved),
  tooltip: (row) => `<b>${escapeHtml(row.name)}</b><br>${formatTokens(row.saved)} filtered out`
    + `<br>${row.calls.toLocaleString('en-US')} ${row.calls === 1 ? 'call' : 'calls'}`,
  valueClass: 'usage-pct usage-count',
  empty: 'No rtk commands in this range.',
};

function renderRtkCommands(commands) {
  if (!commands.some((c) => c.name === selectedRtkCommand)) {
    selectedRtkCommand = commands[0].name;
  }
  const current = commands.find((c) => c.name === selectedRtkCommand);

  const shown = commands.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('rtkCommandBars'), shown, {
    ...RTK_BARS,
    scaleMax: Math.max(...shown.map((c) => c.saved)),
    onSelect: (name) => {
      selectedRtkCommand = name;
      renderRtkCommands(commands);
    },
    selectedName: selectedRtkCommand,
  });

  document.getElementById('rtkDetailTitle').textContent = `Inside rtk ${current.name}`;
  const details = current.details.slice(0, DETAIL_LIMIT);
  drawHBars(document.getElementById('rtkDetailBars'), details, {
    ...RTK_BARS,
    scaleMax: details.length ? Math.max(...details.map((d) => d.saved)) : 0,
  });
}

export function renderRtk(rtk) {
  const live = Boolean(rtk && rtk.meta.dbExists);

  const dailyPanel = document.getElementById('rtkDailyPanel');
  const hasDaily = live && rtk.daily.some((d) => d.saved > 0);
  dailyPanel.hidden = !hasDaily;
  if (hasDaily && shown('rtkDaily')) {
    drawBarChart(document.getElementById('rtkDailyChart'), rtk.daily, {
      // Single series, so no legend and no new hue: this borrows the token palette's
      // blue the way the daily-tokens chart borrows cache-read purple.
      color: '#3987e5',
      valueKey: 'saved',
      tooltipFn: (d) =>
        `<b>${fullDate(d.date)}</b><br>${formatTokens(d.saved)} of ${formatTokens(d.input)} filtered out` +
        `<br>${d.input > 0 ? ((d.saved / d.input) * 100).toFixed(1) : '0.0'}% across ${d.commands.toLocaleString('en-US')} commands`,
    });
  }

  const cmdPanel = document.getElementById('rtkCommandPanel');
  const hasCommands = live && rtk.commands.some((c) => c.saved > 0);
  cmdPanel.hidden = !hasCommands;
  if (hasCommands && shown('rtkCommands')) renderRtkCommands(rtk.commands.filter((c) => c.saved > 0));
}
