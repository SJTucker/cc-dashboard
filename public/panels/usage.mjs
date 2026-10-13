// The charts of tokens and cost over the range: daily cost, daily tokens,
// cumulative cost, token types, and activity by weekday and hour.
import { formatCost, formatTokens, fullDate } from '../format.mjs';
import { state, shown } from '../state.mjs';
import { drawBarChart, drawCumulativeChart } from '../charts/bar.mjs';
import { drawLogLineChart, drawTokenLegend } from '../charts/line.mjs';
import { drawActivityHeatmap } from '../charts/heatmap.mjs';
import { TOKEN_SERIES } from '../charts/palette.mjs';

function drawDailyTokens(daily) {
  // The payload carries the four token types per bucket but not their sum, so the
  // total is derived here rather than widening the wire format for one chart.
  const dailyTokens = daily.map((d) => ({
    ...d,
    tokens: d.input + d.output + d.cacheCreate + d.cacheRead,
  }));
  drawBarChart(document.getElementById('tokenChart'), dailyTokens, {
    // One series that is not money, so the slate series colour.
    color: 'var(--series-neutral)',
    valueKey: 'tokens',
    tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatTokens(d.tokens)} tokens`,
  });
}

export function renderUsageCharts(data) {
  if (shown('dailyCost')) {
    drawBarChart(document.getElementById('costChart'), data.daily, {
      color: 'var(--money-fill)',
      valueKey: 'cost',
      tooltipFn: (d) => `<b>${fullDate(d.date)}</b><br>${formatCost(d.cost)}`,
    });
  }
  if (shown('dailyTokens')) drawDailyTokens(data.daily);
  if (shown('cumulativeCost')) drawCumulativeChart(document.getElementById('cumulativeChart'), data.daily);
  if (shown('tokenTypes')) {
    // Reversed so the legend reads in the order the lines actually appear, cache read
    // at the top down to input at the bottom. TOKEN_SERIES is copied, not reversed in
    // place: the line chart's draw order relies on it.
    drawTokenLegend(document.getElementById('tokenTypeLegend'), data.daily, [...TOKEN_SERIES].reverse());
    drawLogLineChart(document.getElementById('tokenTypeChart'), data.daily, TOKEN_SERIES);
  }
  // Like the model daily charts, the heatmap shows on multi-day ranges only.
  const multiDay = state.currentDays !== 'today';
  document.getElementById('activityPanel').hidden = !multiDay;
  if (multiDay && shown('activity')) drawActivityHeatmap(document.getElementById('activityHeatmap'), data.activity);
}
