// GETs url and parses the JSON body. A 2xx answer whose body has no `error`
// field resolves to the body. Any other outcome resolves to { error, status }:
// error is the body's `detail`, else its `error`, else the thrown error's
// message, and status is the HTTP status, or 0 when no answer arrived. With
// optional, every failure resolves to null instead, for a panel that hides when
// its source fails. It never rejects. fetchImpl is for the tests; the default
// reads the global fetch on each call, so a page script that replaces
// window.fetch is used.
export async function getJson(url, { optional = false, fetchImpl = (...args) => fetch(...args) } = {}) {
  let status = 0;
  try {
    const res = await fetchImpl(url);
    status = res.status;
    const body = await res.json();
    if (res.ok && !body?.error) return body;
    if (optional) return null;
    return { error: String(body?.detail || body?.error || `HTTP ${status}`), status };
  } catch (err) {
    return optional ? null : { error: err.message, status };
  }
}
