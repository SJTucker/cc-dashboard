import { el } from '../dom.mjs';
import { getJson } from '../api.mjs';
import { saveSetting } from './settings-switch.mjs';

// The Mod tab: one row per setting in <cfg>/cc-dashboard/settings.json. The copy is
// the plan's Design section. Nothing here touches the DOM at load time
// (test/modules-load.test.js).

export const MOD_SETTINGS = [
  {
    key: 'handoff',
    label: 'Handoff',
    affects: 'No panel. Live sessions shows a ↪ title only for sessions resumed from a handoff document.',
    info: 'What the mod does when the prompt cache is about to expire.',
    choices: [
      {
        value: 'document',
        label: 'Handoff document',
        info: 'About 7 minutes before a 1-hour prompt cache expires, a fork of the conversation writes a handoff summary to .claude/handoffs/ in the repo. After /clear, the input is prefilled to read it. This costs one model call per idle gap, read from the cache. The summary is short and easy to read, but it leaves out anything the fork did not write down.',
      },
      {
        value: 'transcript',
        label: 'Transcript and index',
        info: 'At the same moment, the mod offers a resume prompt and makes no model call. After /clear, the new session reads the transcript index, then the parts of the old transcript it needs. Nothing is lost, but the new session spends tokens reading the transcript.',
      },
      {
        value: 'off',
        label: 'Off',
        info: 'No timer, no status line offer and no prefill after /clear. /transcript-handoff still prints a resume prompt when you run it.',
      },
    ],
  },
  {
    key: 'transcriptIndex',
    label: 'Transcript index',
    affects: 'No panel. The orchestrate skill needs it.',
    info: 'Rewrites transcript-index/<session id>.md after every turn, with no model call. The orchestrate skill needs it, and the transcript handoff reads it when it exists.',
  },
  {
    key: 'reviews',
    label: 'Session reviews',
    affects: 'Reviews panel',
    info: 'One Haiku call per ended session, to suggest setup changes.',
  },
  {
    key: 'setupMarkers',
    label: 'Setup change markers',
    affects: 'Setup changes panel',
    info: 'At session start, compares CLAUDE.md, settings, skills, agents and hook scripts against the copies saved last time, and records what changed.',
  },
  {
    key: 'setupLabels',
    label: 'Haiku labels and release judging',
    affects: 'Setup changes labels and release markers',
    info: 'One Haiku call per changed prose file to label it, and a changelog fetch plus Haiku calls to judge new Claude Code releases.',
  },
  {
    key: 'activity',
    label: 'Live activity',
    affects: 'Live sessions: State and Doing now',
    info: "Writes each session's state and current tool to activity/<session id>.json, about every 250 ms while it works.",
  },
  {
    key: 'limitBand',
    label: 'Plan limit band',
    affects: 'No panel. The band shows in Claude Code only.',
    info: 'Shows a dismissable band above the prompt at 75% and 90% of a plan limit.',
  },
];

const statusNode = () => document.getElementById('modSettingsStatus');

function showStatus(text) {
  const node = statusNode();
  if (!node) return;
  node.hidden = !text;
  node.textContent = text;
}

function infoNodes(spec) {
  const id = `modInfo-${spec.key}`;
  const button = el('button', {
    type: 'button',
    class: 'info',
    popovertarget: id,
    'aria-label': `About ${spec.label}`,
    text: 'ⓘ',
  });
  const popover = el('div', { popover: '', id, class: 'mod-info' });
  if (spec.choices) {
    popover.appendChild(el('p', { text: spec.info }));
    for (const choice of spec.choices) {
      popover.appendChild(el('p', {}, [el('strong', { text: choice.label }), el('span', { text: `. ${choice.info}` })]));
    }
  } else {
    popover.appendChild(el('p', { text: spec.info }));
  }
  return [button, popover];
}

function controlNodes(spec, value, disabled) {
  const name = `modSetting-${spec.key}`;
  const made = [];
  if (spec.choices) {
    for (const choice of spec.choices) {
      const input = el('input', { type: 'radio', name, value: choice.value });
      input.checked = value === choice.value;
      input.disabled = disabled;
      made.push(el('label', { class: 'mod-choice' }, [input, el('span', { text: ` ${choice.label}` })]));
    }
    return made;
  }
  const input = el('input', { type: 'checkbox', role: 'switch', name });
  input.checked = value !== false;
  input.disabled = disabled;
  return [el('label', { class: 'panel-switch' }, [input, el('span', { text: ' On' })])];
}

// Draws every row from the saved settings. A { error } object draws the rows with
// every control disabled and says so in #modSettingsStatus.
export function renderModSettings(container, settings) {
  const failed = settings?.error !== undefined;
  showStatus(failed ? `Could not load the mod settings: ${settings.error}` : '');
  const rows = MOD_SETTINGS.map((spec) => {
    const head = el('div', { class: 'mod-head' }, [el('span', { class: 'mod-label', text: spec.label }), ...infoNodes(spec)]);
    const controls = el('div', { class: 'mod-controls' }, controlNodes(spec, failed ? undefined : settings?.[spec.key], failed));
    const affects = el('p', { class: 'mod-affects', text: `Affects: ${spec.affects}` });
    return el('div', { class: 'mod-row', id: `modSetting-${spec.key}`, tabindex: '-1' }, [head, controls, affects]);
  });
  container.replaceChildren(...rows);
}

let saved = null;

// GETs /api/settings and draws the rows.
export async function loadModSettings() {
  const body = await getJson('/api/settings');
  if (body.error === undefined) saved = body;
  renderModSettings(document.getElementById('modSettingsRows'), body);
}

function setDisabled(row, disabled) {
  for (const input of row.querySelectorAll('input')) input.disabled = disabled;
}

// Puts the row's control back to the last saved value.
function revert(row, spec) {
  for (const input of row.querySelectorAll('input')) {
    input.checked = spec.choices ? input.value === saved?.[spec.key] : saved?.[spec.key] !== false;
  }
}

// One delegated change listener on the rows. A save disables the row until the POST
// answers. A failure reverts the control and writes #modSettingsStatus. onSaved(key)
// runs after a saved change, so main.mjs can reload the panel the setting feeds.
export function wireModSettings(onSaved) {
  document.getElementById('modSettingsRows').addEventListener('change', async (event) => {
    const input = event.target;
    const key = String(input?.name ?? '').replace(/^modSetting-/, '');
    const spec = MOD_SETTINGS.find((s) => s.key === key);
    if (!spec) return;
    const row = document.getElementById(`modSetting-${key}`);
    const value = spec.choices ? input.value : input.checked;
    setDisabled(row, true);
    const result = await saveSetting(key, value);
    setDisabled(row, false);
    if (result.ok) {
      saved = result.settings ?? { ...saved, [key]: value };
      showStatus('');
      onSaved(key);
      return;
    }
    revert(row, spec);
    if (result.error) showStatus(`Could not save ${spec.label}: ${result.error}`);
  });
}

// Scrolls to a setting's row and focuses it. The panels' "Mod settings" links use it.
export function focusModSetting(key) {
  const row = document.getElementById(`modSetting-${key}`);
  if (!row) return;
  row.scrollIntoView?.({ block: 'center' });
  row.focus({ preventScroll: true });
}
