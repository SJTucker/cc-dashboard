'use strict';

// Loaded two ways: index.html loads it as a script before main.mjs, which makes
// createPoller a global, and the tests load it with require().

// Calls run() every ms milliseconds between start() and stop(). The wait starts
// when a run finishes, so within one chain a run that takes longer than ms delays
// the next one instead of overlapping it. run() must return a promise that never
// rejects. start() and stop() may be called while a run is in progress: that run
// finishes, and only the chain from the latest start() schedules another. A
// start() during a slow run begins a new chain whose first timer can fire while
// the old run is still going, so two runs can overlap once. Every start() and
// stop() bumps `generation`, and a finished run reschedules only when the
// generation it was started under is still the current one. timers is injected
// by the tests. The default wraps the globals in arrows because a browser throws
// "Illegal invocation" when window.setTimeout is called as a method of another
// object.
const GLOBAL_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

function createPoller(run, ms, timers = GLOBAL_TIMERS) {
  let timer = null;
  let generation = 0;
  const schedule = (mine) => {
    timer = timers.setTimeout(async () => {
      await run();
      if (mine === generation) schedule(mine);
    }, ms);
  };
  const stop = () => {
    timers.clearTimeout(timer);
    timer = null;
    generation++;
  };
  return {
    start() {
      stop();
      schedule(generation);
    },
    stop,
    // True from start() to stop(), including while a run is in progress.
    get running() {
      return timer !== null;
    },
  };
}

if (typeof module === 'object') module.exports = { createPoller };
