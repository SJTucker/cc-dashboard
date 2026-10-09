// Two guards that skip stale work. Pure: no DOM, no state outside each guard.

// Numbers the requests of one kind. Responses can arrive out of order (a 30d scan
// takes ~1.9 s and a Today scan ~0.17 s), so each request takes a check from
// next(), and its response is dropped unless the check is still true: it turns
// false as soon as a newer request of the same kind calls next().
export function createSequence() {
  let latest = 0;
  return {
    next() {
      const mine = ++latest;
      return () => mine === latest;
    },
  };
}

// Skips a panel's rebuild when its inputs and the clock minute are unchanged, so
// a 5 s poll does not replace rows the reader is selecting text in. The minute is
// in the key because formatAgo and the "may be stale" suffix change with the
// clock at minute resolution. The stored key is cleared before drawFn runs and set
// after it returns, so a draw that throws leaves no key. A panel left half drawn
// by a throw is drawn again on the next call, even when that call carries the
// parts of the last good draw. now is for the tests.
export function createDrawGuard({ now = Date.now } = {}) {
  let last = null;
  return {
    draw(parts, drawFn) {
      const key = JSON.stringify([parts, Math.floor(now() / 60_000)]);
      if (key === last) return false;
      last = null;
      drawFn();
      last = key;
      return true;
    },
  };
}
