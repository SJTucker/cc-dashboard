// The Suggestions and Haiku labels switches: saving the choice to /api/settings and
// the dialog that asks what to do with sessions that ended while suggestions were off.

// POSTs a settings change. Resolves to { ok: true, settings }, to
// { ok: false, backlog } when the server wants a review-or-skip choice (409), or to
// { ok: false, error }. error is the body's `detail`, else its `error`, else
// `HTTP <status>`, else the thrown error's message. It never rejects.
export async function saveSettings(body, fetchImpl = (...args) => fetch(...args)) {
  let status = 0;
  try {
    const res = await fetchImpl('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = res.status;
    const answer = await res.json().catch(() => null);
    if (res.ok) return { ok: true, settings: answer };
    if (status === 409 && answer?.error === 'backlog') return { ok: false, backlog: answer.backlog };
    return { ok: false, error: String(answer?.detail || answer?.error || `HTTP ${status}`) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function backlogText(count) {
  const noun = count === 1 ? '1 session' : `${count} sessions`;
  return `${noun} ended in the last 7 days while suggestions were off. Reviewing them makes one Haiku call per session.`;
}

// Opens #reviewsBacklog and resolves to 'review', 'skip', or null for Cancel and Esc.
export function askBacklog(count) {
  const dialog = document.getElementById('reviewsBacklog');
  document.getElementById('reviewsBacklogText').textContent = backlogText(count);
  return new Promise((resolve) => {
    let choice = null;
    const done = () => {
      dialog.removeEventListener('close', done);
      dialog.removeEventListener('click', onClick);
      resolve(choice);
    };
    const onClick = (event) => {
      const value = event.target.dataset?.backlog;
      if (value === undefined) return;
      choice = value === 'review' || value === 'skip' ? value : null;
      dialog.close();
    };
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('close', done);
    dialog.showModal();
  });
}

// Wires the Suggestions switch. onSaved reloads the reviews request.
export function wireReviewsSwitch(onSaved) {
  const box = document.getElementById('reviewsSwitch');
  const status = document.getElementById('reviewsStatus');
  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    let result = await saveSettings({ reviews: want });
    if (want && result.backlog !== undefined) {
      const choice = await askBacklog(result.backlog);
      result = choice ? await saveSettings({ reviews: true, backlog: choice }) : { ok: false, cancelled: true };
    }
    box.disabled = false;
    if (result.ok) {
      onSaved();
      return;
    }
    box.checked = !want;
    if (result.error) {
      status.hidden = false;
      status.textContent = `Could not save the Suggestions setting: ${result.error}`;
    }
  });
}

// Wires the Haiku labels switch.
export function wireLabelsSwitch() {
  const box = document.getElementById('labelsSwitch');
  const note = document.getElementById('changesFileNote');
  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    const result = await saveSettings({ setupLabels: want });
    box.disabled = false;
    if (result.ok) return;
    box.checked = !want;
    note.hidden = false;
    note.classList.add('changes-error');
    note.textContent = `Could not save the Haiku labels setting: ${result.error}`;
  });
}
