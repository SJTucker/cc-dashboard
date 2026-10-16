// The prices note in the Models panel and the Check prices button. A check applies
// what it finds at once, so there is no preview and no date to pick.
import { el } from '../dom.mjs';
import { state } from '../state.mjs';
import { neededRequests } from '../visibility.mjs';
import { checkLines, sourceLine } from '../price-lines.mjs';

// Runs after a check that added or changed a price. main.mjs passes reloadAll,
// because costs are computed in the server's scan and the server has just dropped
// that scan.
let onApplied = () => {};

// An answer that is not JSON (an HTML error page from a proxy or a crashed route)
// gives { error: 'HTTP <status>' }, so the page shows the status and not a
// JSON parse message.
export async function postJson(url) {
  const res = await fetch(url, { method: 'POST' });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

export async function loadPricesSource() {
  if (!neededRequests(state.hiddenKeys, state.tab).has('prices')) return;
  const note = document.getElementById('pricesSource');
  // /api/prices answers 200 with an error field when prices.json was ignored.
  // That field is a warning to show, so this request does not use getJson.
  const res = await fetch('/api/prices').catch(() => null);
  const source = res?.ok ? await res.json().catch(() => null) : null;
  note.textContent = source ? sourceLine(source) : '';
}

function renderPricesCheck(result) {
  const box = document.getElementById('pricesCheck');
  box.hidden = false;
  box.innerHTML = '';
  const lines = result.error ? [result.error] : checkLines(result);
  for (const text of lines) box.appendChild(el('p', { class: 'panel-note', text }));
}

export function setupPrices(callbacks) {
  ({ onApplied } = callbacks);
  document.getElementById('checkPricesBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const result = await postJson('/api/prices/check')
      .catch((err) => ({ error: `Could not reach the dashboard server: ${err.message}` }));
    btn.disabled = false;
    btn.textContent = 'Check prices';
    renderPricesCheck(result);
    loadPricesSource();
    if (!result.error && (result.added.length || result.changed.length)) onApplied();
  });
}
