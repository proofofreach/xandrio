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
  onStall = () => {},
  // Smaller stalls still matter to a page waiting on a response; they go to
  // the administrator telemetry trail without filling the service log.
  stallThresholdMs = 250,
  createHistogram = () => monitorEventLoopDelay({ resolution: 20 }),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const histogram = createHistogram();
  histogram.enable();
  const timer = setIntervalFn(() => {
    const maxMs = Math.round(histogram.max / 1e6);
    if (maxMs >= Math.min(thresholdMs, stallThresholdMs)) {
      const p99Ms = Math.round(histogram.percentile(99) / 1e6);
      if (maxMs >= thresholdMs) {
        log(`[event-loop] blocked up to ${maxMs}ms in the last ${Math.round(intervalMs / 1000)}s (p99 ${p99Ms}ms)`);
      }
      try { onStall({ maxMs, p99Ms }); } catch {}
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
