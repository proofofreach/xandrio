'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

// A blocked event loop stalls every request at once: playlists, segments and
// status polls for all listeners. Clients then see slow starts and stalls
// while the server logs no error. Report each interval whose worst delay
// crosses the threshold so the stall is visible and can be timed.
function startEventLoopMonitor({
  thresholdMs = 1000,
  intervalMs = 30 * 1000,
  log = message => console.warn(message),
  createHistogram = () => monitorEventLoopDelay({ resolution: 20 }),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const histogram = createHistogram();
  histogram.enable();
  const timer = setIntervalFn(() => {
    const maxMs = Math.round(histogram.max / 1e6);
    if (maxMs >= thresholdMs) {
      const p99Ms = Math.round(histogram.percentile(99) / 1e6);
      log(`[event-loop] blocked up to ${maxMs}ms in the last ${Math.round(intervalMs / 1000)}s (p99 ${p99Ms}ms)`);
    }
    histogram.reset();
  }, intervalMs);
  timer?.unref?.();
  return {
    stop() {
      clearIntervalFn(timer);
      histogram.disable();
    }
  };
}

module.exports = { startEventLoopMonitor };
