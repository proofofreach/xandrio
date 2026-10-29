// Summarizes one listening session from the player's diagnostic events and
// reports it when the page is hidden. The report holds timings and counts
// only: no book, chapter, text, position or account identifier.

const REPORT_VERSION = 1;
const MAX_SAMPLES = 20;
const ERROR_TYPES = new Set([
  'error',
  'stalled-timeout',
  'unexpected-ended',
  'chapter-advance-failed',
  'chapter-prewarm-failed',
  'source-reload-failed'
]);

export function platformClass(userAgent = '', maxTouchPoints = 0) {
  const agent = String(userAgent);
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(agent)) return 'android';
  if (/Windows|Macintosh|Linux|CrOS/.test(agent)) return 'desktop';
  return 'other';
}

export function createPlaybackHealth({
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  platform = 'other',
  standalone = false,
  send = null
} = {}) {
  let session = null;
  let backend = 'unknown';
  // A start or boundary wait in progress, and whether audio is running.
  let pendingStartAt = null;
  let pendingBoundaryAt = null;
  let stallStartedAt = null;
  let playingSince = null;

  function current() {
    session ||= {
      startupMs: [],
      abandonedStartMs: [],
      boundaryWaitMs: [],
      stalls: 0,
      stallMs: 0,
      recoveries: 0,
      listenedMs: 0,
      errors: {}
    };
    return session;
  }

  function sample(list, value) {
    if (list.length < MAX_SAMPLES) list.push(Math.max(0, Math.round(value)));
  }

  function stopListening(at) {
    if (playingSince !== null) current().listenedMs += Math.max(0, at - playingSince);
    playingSince = null;
  }

  function endStall(at) {
    if (stallStartedAt !== null) current().stallMs += Math.max(0, at - stallStartedAt);
    stallStartedAt = null;
  }

  function observe(event = {}) {
    const type = String(event.type || '');
    const at = now();
    if (event.sourceKind === 'continuous') backend = 'audio-stream';
    else if (event.sourceKind === 'chapter') backend = 'single-file';

    if (type === 'play-intent') {
      // The listener asked for audio. Startup runs until it is heard.
      if (playingSince === null && pendingStartAt === null && stallStartedAt === null) pendingStartAt = at;
    } else if (type === 'pause-intent') {
      // The listener stopped asking. A start they gave up on is its own
      // sample, so slow starts are not hidden by listeners who stop waiting.
      stopListening(at);
      endStall(at);
      if (pendingStartAt !== null) sample(current().abandonedStartMs, at - pendingStartAt);
      pendingStartAt = null;
      pendingBoundaryAt = null;
    } else if (type === 'load-chapter') {
      // Switching chapter while audio runs is a new start. A reload during a
      // stall is recovery, so the stall stays open until audio resumes.
      if (playingSince !== null) {
        stopListening(at);
        pendingStartAt = at;
      }
    } else if (type === 'playing') {
      if (pendingStartAt !== null) {
        sample(current().startupMs, at - pendingStartAt);
        pendingStartAt = null;
      }
      if (pendingBoundaryAt !== null) {
        sample(current().boundaryWaitMs, at - pendingBoundaryAt);
        pendingBoundaryAt = null;
      }
      endStall(at);
      if (playingSince === null) playingSince = at;
    } else if (type === 'waiting') {
      // Only a stall during running audio. Waiting while a start is pending is
      // part of the startup time already being measured.
      if (playingSince !== null && pendingStartAt === null && stallStartedAt === null) {
        current().stalls += 1;
        stallStartedAt = at;
        stopListening(at);
      }
    } else if (type === 'chapter-advance-waiting') {
      pendingBoundaryAt ??= at;
    } else if (type === 'pause' || type === 'ended' || type === 'continuous-limit-ended') {
      // Engine pauses also happen inside reloads and recovery, so only the
      // listener's pause intent abandons a pending wait.
      stopListening(at);
    } else if (type === 'automatic-recovery') {
      current().recoveries += 1;
    }

    if (ERROR_TYPES.has(type)) {
      const errors = current().errors;
      errors[type] = (errors[type] || 0) + 1;
    }
  }

  // Closes open intervals and returns the report, or null when nothing
  // happened. Running audio keeps running: the next interval starts now.
  function takeReport() {
    const at = now();
    const wasPlaying = playingSince !== null;
    stopListening(at);
    if (stallStartedAt !== null) {
      current().stallMs += Math.max(0, at - stallStartedAt);
      stallStartedAt = at;
    }
    if (wasPlaying) playingSince = at;
    const taken = session;
    session = null;
    if (!taken) return null;
    const listenedSeconds = Math.round(taken.listenedMs / 1000);
    const hasSignal = taken.startupMs.length || taken.abandonedStartMs.length
      || taken.boundaryWaitMs.length || listenedSeconds
      || taken.stalls || Object.keys(taken.errors).length;
    if (!hasSignal) return null;
    return {
      v: REPORT_VERSION,
      platform,
      standalone: Boolean(standalone),
      backend,
      startupMs: taken.startupMs,
      abandonedStartMs: taken.abandonedStartMs,
      boundaryWaitMs: taken.boundaryWaitMs,
      stalls: taken.stalls,
      stallMs: Math.round(taken.stallMs),
      recoveries: taken.recoveries,
      listenedSeconds,
      errors: taken.errors
    };
  }

  function flush() {
    const report = takeReport();
    if (!report || typeof send !== 'function') return report;
    try {
      send(report);
    } catch {}
    return report;
  }

  return { observe, takeReport, flush };
}

// Sends a report so it survives page unload. Same-origin fetch carries the
// session cookie and passes the CSRF guard, which sendBeacon cannot do with a
// JSON body on every browser.
export function sendPlaybackHealthReport(report, { fetch = globalThis.fetch, apiBase = '' } = {}) {
  if (typeof fetch !== 'function') return;
  fetch(`${apiBase}/api/playback-health`, {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report)
  }).catch(() => {});
}
