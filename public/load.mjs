// Draws each panel of a page load as its own request settles, instead of when the
// slowest request does. No DOM access, so node:test drives it with stub promises
// (test/load.test.js). public/main.mjs passes it the real requests and renderers.
//
// requests: { summary, rtk, limits, sessions, reviews }, five promises that never
//   reject (getJson in public/api.mjs resolves to an error payload instead).
// draws: the same five names, each a function of that request's value. A draw runs
//   only while isLatest() is true, so a response from a superseded load draws nothing.
// reportDrawError(err): receives the error of a draw that threw. The load goes on.
// onAllSettled(values): runs once every request has settled and every draw has run,
//   when the load is still the latest. A draw that threw does not prevent it.
//
// A failed summary writes its error banner after the limits draw of the same load,
// because the limits banner must be on the page first. A summary that loaded does not
// wait for limits.
//
// Resolves to { summary, rtk, limits, sessions, reviews }, or null when a newer load
// superseded this one.
export async function loadPanels({ requests, draws, isLatest, reportDrawError, onAllSettled }) {
  const drawOne = (name, value) => {
    if (!isLatest()) return;
    try {
      draws[name](value);
    } catch (err) {
      reportDrawError(err);
    }
  };

  const limitsDrawn = requests.limits.then((value) => drawOne('limits', value));
  const drawn = [
    limitsDrawn,
    requests.reviews.then((value) => drawOne('reviews', value)),
    requests.sessions.then((value) => drawOne('sessions', value)),
    requests.rtk.then((value) => drawOne('rtk', value)),
    requests.summary.then(async (value) => {
      if (value && value.error) await limitsDrawn;
      drawOne('summary', value);
    }),
  ];
  await Promise.all(drawn);

  if (!isLatest()) return null;
  const [summary, rtk, limits, sessions, reviews] = await Promise.all([
    requests.summary, requests.rtk, requests.limits, requests.sessions, requests.reviews,
  ]);
  const values = { summary, rtk, limits, sessions, reviews };
  onAllSettled(values);
  return values;
}
