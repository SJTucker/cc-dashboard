// Text formatting for the page. Pure: no DOM, no state.

export function formatCost(usd) {
  if (usd == null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function formatPercent(x) {
  if (x == null) return '—';
  return (x * 100).toFixed(1) + '%';
}

// Wall and API durations for the Live sessions panel.
export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// How long ago a session last wrote to its transcript. After an hour the clock
// time reads better than "137m ago".
export function formatAgo(ms, now = Date.now()) {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Mirrors localDateStr in lib/dates.js so the front end can tell which bucket is
// today without parsing a locale-formatted string.
export function localDateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Average cost per COMPLETE day. Today is excluded because it is partial and
// would drag the average down. The divisor is the calendar span between the
// first and last complete bucket, not the bucket count. aggregate
// (lib/aggregate.js) fills idle days with zero buckets, so the two are equal for
// its output. The span still gives the right rate for a daily list with days
// missing.
export function costPerDay(daily, today = localDateStr(new Date())) {
  const complete = daily.filter((d) => d.date !== today);
  if (!complete.length) return null;
  const first = new Date(complete[0].date + 'T00:00:00');
  const last = new Date(complete[complete.length - 1].date + 'T00:00:00');
  const span = Math.round((last - first) / 86400000) + 1;
  // Hour keys ('2026-09-21T14') do not parse as a date, which would make span
  // NaN. Only the daily ranges call this today, but nothing in the signature
  // says so.
  if (!Number.isFinite(span) || span <= 0) return null;
  const total = complete.reduce((sum, d) => sum + d.cost, 0);
  return total / span;
}

// Bucket keys are either '2026-09-21' (day) or '2026-09-21T14' (hour).
export function shortDate(key) {
  if (key.includes('T')) return key.slice(-2) + ':00';
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function fullDate(key) {
  if (key.includes('T')) {
    const [date, hour] = key.split('T');
    return `${date} ${hour}:00`;
  }
  return key;
}

// Every value interpolated into innerHTML goes through this: model, skill, tool
// and session names, commands, paths and error text all come from files on disk.
// It escapes all five characters HTML treats as markup.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Axis ticks are round by construction, so formatTokens' fixed 2 decimals only adds
// "200.00M" where "200M" says the same thing in less width.
export function axisTokens(n) {
  return formatTokens(n).replace(/\.0+(?=[kMB]$)/, '');
}

// A compact cost for the y axis: formatCost's grouped "$1,200.00" is wider than
// the axis gutter. Gridline values are round by construction but not whole:
// axisScale (public/chart-geometry.js) picks a step of 0.5 whenever the max lands
// in (0.80, 2.00], so dropping the cents labelled the $1.50 line "$2" and left
// two ticks reading the same number.
export function axisCost(usd) {
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'k';
  if (usd >= 10) return '$' + usd.toFixed(0);
  return '$' + usd.toFixed(2).replace(/\.00$/, '');
}

// A model id without its "claude-" prefix and without a date suffix:
// "claude-haiku-4-5-20251001" -> "haiku-4-5", "claude-sonnet-5" -> "sonnet-5".
// Each version part is one or two digits not followed by another digit, so the
// match stops before an eight-digit date. Any other id is returned whole.
export function shortModel(name) {
  const m = name.match(/claude-([a-z]+)-(\d{1,2}(?!\d)(?:[.-]\d{1,2}(?!\d))*)/i);
  return m ? `${m[1]}-${m[2]}` : name;
}
