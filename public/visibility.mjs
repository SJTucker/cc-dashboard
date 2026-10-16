// The optional requests and the hide keys of the panels and cards each one feeds.
// A request is skipped when every key it feeds is hidden. An empty list means a
// consumer that cannot be hidden: /api/records feeds the sticky bar's 7d lines and
// Record day. /api/summary and /api/limits are not listed, because they are always
// fetched.
const REQUEST_CONSUMERS = {
  changes: ['beforeAfter'],
  rtk: ['rtkDaily', 'rtkCommands'],
  sessions: ['sessions', 'timeline'],
  reviews: ['reviews'],
  records: [],
  prices: ['costByModel'],
};

// The requests whose panels are on each tab. The Now tab is the Today range and the
// Analysis tab is every other range (public/ui/tabs.mjs), so the range names the tab.
const NOW_REQUESTS = ['sessions', 'records', 'prices'];
const ANALYSIS_REQUESTS = ['changes', 'rtk', 'reviews', 'records'];
// The High scores tab has range 'highscores'. Only the sticky bar's records show.
const HIGHSCORES_REQUESTS = ['records'];

// The hidden keys saved in localStorage. Anything that is not a JSON list gives
// an empty list, and entries that are not strings are dropped.
function parseHidden(raw) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

// The optional requests the open tab still needs: those whose panels are on the tab
// and not all hidden. The tab picks the set, not the range, because Analysis can
// be on the Today range too.
function neededRequests(hidden, tab) {
  let onTab = ANALYSIS_REQUESTS;
  if (tab === 'now') onTab = NOW_REQUESTS;
  else if (tab === 'highscores') onTab = HIGHSCORES_REQUESTS;
  const needed = new Set();
  for (const request of onTab) {
    const keys = REQUEST_CONSUMERS[request];
    if (!keys.length || keys.some((key) => !hidden.has(key))) needed.add(request);
  }
  return needed;
}

export { REQUEST_CONSUMERS, parseHidden, neededRequests };
