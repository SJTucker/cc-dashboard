// The prices note in the Models panel, Check prices, and Apply.
import { el } from '../dom.mjs';
import { localDateStr } from '../format.mjs';
import { state } from '../state.mjs';
import { neededRequests } from '../visibility.mjs';

// Runs after Apply succeeds. main.mjs passes reloadAll, because costs are
// computed in the server's scan and the server has just dropped that scan.
let onApplied = () => {};

// Prices per million tokens, as the pricing page writes them: "$4 / $20".
function rateText(row) {
  let text = `$${row.input} / $${row.output}`;
  if (row.cacheReadMult != null) text += ` · cache read ${row.cacheReadMult}x`;
  if (row.fast) text += ` · fast $${row.fast.input} / $${row.fast.output}`;
  return text;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// The last applied snapshot's effective date, or null on built-in prices.
// Set from loadPricesSource() and read by renderPricesCheck to floor the
// Apply date picker: the server already refuses a date before this one, so
// the picker should not offer it.
let lastAppliedDate = null;

export async function loadPricesSource() {
  if (!neededRequests(state.hiddenKeys, state.currentDays).has('prices')) return;
  const note = document.getElementById('pricesSource');
  // /api/prices answers 200 with an error field when prices.json was ignored.
  // That field is a warning to show, so this request does not use getJson.
  const res = await fetch('/api/prices').catch(() => null);
  const source = res?.ok ? await res.json().catch(() => null) : null;
  if (!source) {
    note.textContent = '';
    return;
  }
  lastAppliedDate = source.kind === 'fetched' ? source.date : null;
  note.textContent = source.kind === 'built-in'
    ? `Prices: built-in, checked ${source.date}`
    : `Prices: from Anthropic's pricing page, effective ${source.date}`;
  if (source.error) note.textContent += ` · prices.json ignored: ${source.error}`;
}

function renderPricesCheck(result) {
  const box = document.getElementById('pricesCheck');
  box.hidden = false;
  box.innerHTML = '';
  if (result.error) {
    box.appendChild(el('p', { class: 'panel-note', text: result.error }));
    return;
  }
  const lines = [
    ...result.added.map((r) => `New: ${r.name} ${rateText(r)}`),
    ...result.changed.map((c) => `Changed: ${c.after.name} ${rateText(c.before)} → ${rateText(c.after)}`),
    ...result.skipped.map((s) => `Skipped: ${s.name} (${s.reason})`),
  ];
  for (const text of lines) box.appendChild(el('p', { class: 'panel-note', text }));
  if (!result.added.length && !result.changed.length) {
    box.appendChild(el('p', { class: 'panel-note', text: `Prices match Anthropic's pricing page (${result.unchanged} models).` }));
    return;
  }
  const today = localDateStr(new Date());
  const date = el('input', {
    type: 'date', id: 'pricesEffective', value: today, max: today,
    ...(lastAppliedDate ? { min: lastAppliedDate } : {}),
  });
  const apply = el('button', { class: 'refresh-btn', type: 'button', text: 'Apply' });
  apply.addEventListener('click', () => applyPrices(date.value));
  box.appendChild(el('div', { class: 'prices-apply' }, [el('label', { for: 'pricesEffective', text: 'Effective from' }), date, apply]));
  box.appendChild(el('p', { class: 'panel-note', text: 'Usage before this date keeps its old prices. New models are priced for all dates.' }));
}

async function applyPrices(effectiveFrom) {
  const result = await postJson('/api/prices/apply', { effectiveFrom })
    .catch((err) => ({ error: `Could not reach the dashboard server: ${err.message}` }));
  const box = document.getElementById('pricesCheck');
  if (result.error) {
    // Keep the diff on screen, so a refused date can be corrected and applied again.
    // Drop any earlier error line first, so retrying a bad date doesn't pile them up.
    box.querySelectorAll('.prices-error').forEach((node) => node.remove());
    box.appendChild(el('p', { class: 'panel-note prices-error', text: result.error }));
    return;
  }
  box.hidden = true;
  loadPricesSource();
  onApplied();
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
  });
}
