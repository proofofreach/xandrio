// Library status vocabulary: one place that turns a book's device copy,
// its narration preparation and its listening progress into the words the
// library rows, grid cells, desktop table and book actions sheet show.
//
// Pure: no DOM, no storage, no network. Node tests import it directly.
//
// Every state has a long form ("Narration failed") and a short form
// ("Failed"). The status line truncation rule (see statusLineVariants):
//   1. "9h 12m left at 1.0× · Narration failed"
//   2. drop the per-book speed suffix: "9h 12m left · Narration failed"
//   3. shorten the state word:          "9h 12m left · Failed"
// The state word is never cut mid-word: the view lays the state out as an
// unshrinkable span, so anything still too long clips the time instead.

import { formatDuration, formatSpeed, sameSpeed } from './time-left.mjs';

const BUSY_DEVICE_KINDS = new Set(['preparing', 'preparation-waiting', 'downloading', 'verifying']);

function percentOf(done, total) {
  const a = Number(done);
  const b = Number(total);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((a / b) * 100)));
}

function state(long, short = long, extra = {}) {
  return { long, short: short || long, warn: false, ...extra };
}

// The on-device copy, from offlineStatusForBook(). Returns the words plus
// the trailing control: glyph ('download' | 'ring' | 'check' | 'retry'),
// what a tap does ('download' runs the offline action, 'menu' opens the
// book actions where Cancel / Remove live, 'none' is inert), and whether
// the state is worth stating on the phone status line ("notable").
export function deviceState(status = {}, { pending = false } = {}) {
  const kind = status.kind || 'ready-to-prepare';
  const cached = Math.max(0, Number(status.cachedChapters) || 0);
  const total = Math.max(0, Number(status.totalChapters) || 0);
  if (pending) {
    return { ...state('Checking audio', 'Checking'), kind: 'pending', glyph: 'ring', percent: null, tap: 'none', notable: true };
  }
  if (status.downloaded) {
    return { ...state('On device'), kind: 'downloaded', glyph: 'check', percent: 100, tap: 'menu', notable: true, column: 'Downloaded' };
  }
  switch (kind) {
    case 'preparing': {
      const percent = percentOf(status.preparedChapters, total);
      return {
        ...state(percent === null ? 'Preparing' : `Preparing ${percent}%`, percent === null ? 'Preparing' : `${percent}% ready`),
        kind, glyph: 'ring', percent, tap: 'menu', notable: true, column: percent === null ? 'Preparing' : `${percent}%`
      };
    }
    case 'preparation-waiting':
      return { ...state('Waiting for audio', 'Waiting'), kind, glyph: 'ring', percent: null, tap: 'menu', notable: true, column: 'Waiting' };
    case 'downloading': {
      const percent = percentOf(cached, total);
      return {
        ...state(percent === null ? 'Downloading' : `Downloading ${percent}%`, percent === null ? 'Saving' : `Saving ${percent}%`),
        kind, glyph: 'ring', percent, tap: 'menu', notable: true, column: percent === null ? 'Downloading' : `${percent}%`
      };
    }
    case 'verifying':
      return { ...state('Verifying', 'Verifying'), kind, glyph: 'ring', percent: null, tap: 'menu', notable: true, column: 'Verifying' };
    case 'prepared':
      return status.autoResume
        ? { ...state('Waiting to download', 'Waiting'), kind, glyph: 'ring', percent: null, tap: 'menu', notable: true, column: 'Waiting' }
        : { ...state('All ready'), kind, glyph: 'download', percent: null, tap: 'download', notable: true, column: 'Ready to download', action: 'Download' };
    case 'preparation-paused':
      return { ...state('Download paused', 'Paused'), kind, glyph: 'download', percent: null, tap: 'download', notable: true, column: 'Paused', action: 'Resume' };
    case 'preparation-error':
      return { ...state('Narration failed', 'Failed', { warn: true }), kind, glyph: 'retry', percent: null, tap: 'download', notable: true, column: 'Retry', action: 'Retry' };
    case 'preparation-capacity':
      return { ...state('Queue full', 'Queue full', { warn: true }), kind, glyph: 'retry', percent: null, tap: 'download', notable: true, column: 'Try again', action: 'Try again' };
    case 'partial-download':
      return {
        ...state(total ? `Partial ${cached}/${total}` : 'Partial', total ? `${cached}/${total}` : 'Partial'),
        kind, glyph: 'download', percent: percentOf(cached, total), tap: 'download', notable: true,
        column: total ? `Partial ${cached}/${total}` : 'Partial', action: total ? `Partial ${cached}/${total} · Continue` : 'Partial · Continue'
      };
    case 'repair-needed':
      return { ...state('Download incomplete', 'Incomplete', { warn: true }), kind, glyph: 'retry', percent: null, tap: 'download', notable: true, column: 'Incomplete', action: 'Incomplete · Retry' };
    case 'partial':
      // The automatic chapter cache: a few chapters around the listening
      // point. Worth saying, but less urgent than narration problems.
      return {
        ...state(cached ? `${cached} ${cached === 1 ? 'chapter' : 'chapters'} cached` : 'Cached', cached ? `${cached} cached` : 'Cached'),
        kind, glyph: 'download', percent: null, tap: 'download', notable: false,
        column: cached ? `${cached} cached` : 'Cached', action: total ? `Cached ${cached}/${total} · Download full copy` : 'Cached chapters · Download full copy'
      };
    case 'download-offline':
      return { ...state('Connect to download', 'Offline'), kind, glyph: 'download', percent: null, tap: 'none', notable: false, column: '—', disabled: true };
    case 'download-unavailable':
      return { ...state('Downloads unavailable', 'Unavailable'), kind, glyph: 'download', percent: null, tap: 'none', notable: false, column: '—', disabled: true };
    case 'ready-to-prepare':
    default:
      return { ...state('Not downloaded'), kind: 'ready-to-prepare', glyph: 'download', percent: null, tap: 'download', notable: false, column: '—', action: 'Download' };
  }
}

export function isBusyDeviceKind(kind) {
  return BUSY_DEVICE_KINDS.has(kind);
}

// Narration preparation on the server, from the Audio activity poll
// (/api/queue/status row for this book) and the library record's import
// warm-up fields. Returns null when the app has no narration fact to state;
// it never claims "Not prepared" or "All ready" without evidence.
//   activity — { failed, preparationStatus, readyChapters, totalChapters,
//                readyAudioSeconds, active, queued } or null
//   speed    — the book's effective speed, for "2h 10m ready"
export function narrationState(book = {}, activity = null, speed = 1) {
  if (activity) {
    if (activity.failed || activity.preparationStatus === 'error') {
      return state('Narration failed', 'Failed', { warn: true });
    }
    if (activity.preparationStatus === 'engineOffline') {
      return state('Narrator offline', 'Offline', { warn: true });
    }
    const percent = percentOf(activity.readyChapters, activity.totalChapters);
    if (activity.preparationStatus === 'generating') {
      return percent === null ? state('Preparing') : state(`Preparing ${percent}%`, `${percent}% ready`);
    }
    if (activity.preparationStatus === 'userPaused') {
      return percent === null ? state('Preparation paused', 'Paused') : state(`Paused at ${percent}%`, 'Paused');
    }
    const readySeconds = Number(activity.readyAudioSeconds) / (Number(speed) || 1);
    if (['paused', 'idle'].includes(activity.preparationStatus) && Number.isFinite(readySeconds) && readySeconds >= 60) {
      const ready = `${formatDuration(readySeconds)} ready`;
      return state(ready, ready);
    }
    if (Number(activity.active) > 0 || Number(activity.queued) > 0) return state('Preparing');
  }
  if (book.audioGenerationState === 'error') return state('Narration failed', 'Failed', { warn: true });
  if (book.audioGenerationState === 'generating') {
    const percent = percentOf(book.audioGeneratedChapters, book.audioGenerationTotal);
    return percent === null ? state('Preparing') : state(`Preparing ${percent}%`, `${percent}% ready`);
  }
  // chapterDurations / chapter1Ready are not narrator-scoped: they survive a
  // narrator change while the audio cache does not, so they cannot prove that
  // the selected narrator is ready. Say nothing rather than claim readiness.
  return null;
}


// The one state a phone row states: a notable device state first (on
// device, downloading, a failed offline preparation), then narration, then
// a quieter device fact, then the listening context.
export function primaryState({ device = null, narration = null, context = null } = {}) {
  if (device?.notable) return device;
  if (narration) return narration;
  if (device && device.kind === 'partial') return device;
  return context;
}

// Status line variants in truncation order. Each is { time, state, warn }.
//   timeLeft       — seconds at the book's effective speed (null if unknown)
//   speed          — the book's effective speed
//   referenceSpeed — the speed the sort line states ("Time left at 1.25×")
//   fallbackTime   — shown when there is no time left (e.g. "12h 00m")
export function statusLineVariants({ timeLeft = null, speed = 1, referenceSpeed = null, fallbackTime = '', stateWord = null } = {}) {
  let base = fallbackTime || '';
  let withSpeed = base;
  if (timeLeft !== null && timeLeft !== undefined && Number.isFinite(Number(timeLeft))) {
    const value = Number(timeLeft);
    if (value === 0) {
      base = 'Finished';
      withSpeed = base;
    } else {
      base = `${formatDuration(value)} left`;
      const differs = referenceSpeed !== null && referenceSpeed !== undefined && !sameSpeed(speed, referenceSpeed);
      withSpeed = differs ? `${base} at ${formatSpeed(speed)}` : base;
    }
  }
  const long = stateWord?.long || '';
  const short = stateWord?.short || long;
  const warn = Boolean(stateWord?.warn);
  const variants = [
    { time: withSpeed, state: long, warn },
    { time: base, state: long, warn },
    { time: base, state: short, warn }
  ];
  return variants.filter((variant, index) =>
    index === 0 || variant.time !== variants[index - 1].time || variant.state !== variants[index - 1].state);
}

// Grid cells stack time and state on two short lines. Line one keeps the
// per-book speed in a compact form before dropping it ("6h 02m · 1.0×").
export function gridTimeVariants({ timeLeft = null, speed = 1, referenceSpeed = null, fallbackTime = '' } = {}) {
  if (timeLeft === null || timeLeft === undefined || !Number.isFinite(Number(timeLeft))) return [fallbackTime || ''];
  const value = Number(timeLeft);
  if (value === 0) return ['Finished'];
  const duration = formatDuration(value);
  const differs = referenceSpeed !== null && referenceSpeed !== undefined && !sameSpeed(speed, referenceSpeed);
  return differs
    ? [`${duration} left at ${formatSpeed(speed)}`, `${duration} · ${formatSpeed(speed)}`, `${duration} left`]
    : [`${duration} left`];
}
