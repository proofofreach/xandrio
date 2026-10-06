// One time vocabulary for the whole client.
//
// Every "time left" string in Xandrio comes from this module: the library
// rows and Continue strip, the mini player, the player, the Recent sheet and
// the stats view. Remaining audio is computed once from the book's chapter
// timeline, divided by the book's effective speed, and written by one
// formatter so the library and the player always agree.
//
// Pure: no DOM, no storage, no network. Node tests import it directly.

// Duration in whole minutes, rounded first and then split, so a value just
// under an hour boundary carries ("11h 59.6m" -> "12h 00m", never "11h 60m").
//   < 1 minute  -> "< 1m"
//   < 1 hour    -> "45m"
//   >= 1 hour   -> "9h 12m" / "6h 02m" (minutes always two digits)
export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 60) return '< 1m';
  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;

// A usable playback rate, or null when the value is missing or out of range.
export function validSpeed(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value < MIN_SPEED || value > MAX_SPEED) return null;
  return Math.round(value * 100) / 100;
}

// The first usable rate wins; 1 when none is usable.
export function effectiveSpeed(...candidates) {
  for (const candidate of candidates) {
    const speed = validSpeed(candidate);
    if (speed !== null) return speed;
  }
  return 1;
}

// "1.0×", "1.25×", "1.5×", "2.0×". Whole and half rates keep one decimal so
// the label never reads as an integer count.
export function formatSpeed(rate) {
  const speed = effectiveSpeed(rate);
  const fixed = speed.toFixed(2).replace(/0$/, '');
  return `${fixed}×`;
}

export function sameSpeed(a, b) {
  return Math.abs(effectiveSpeed(a) - effectiveSpeed(b)) < 0.001;
}

export function chapterDurationsFor(book, chapterCount = book?.chapterCount) {
  const count = Number(chapterCount);
  if (!book || !Number.isInteger(count) || count <= 0 || !Array.isArray(book.chapterDurations)) return null;
  const durations = book.chapterDurations.slice(0, count).map(value => Number(value));
  if (durations.length !== count || !durations.every(value => Number.isFinite(value) && value > 0)) return null;
  return durations;
}

function clampPercent(elapsed, total) {
  return Math.min(99, Math.max(0, Math.round((elapsed / total) * 100)));
}

// Audio position within a book, in seconds of 1x audio.
//   book     — { chapterDurations?, chapterCount?, totalDuration? }
//   position — { chapterIndex, timestamp | currentTime, finished? }
//   chapterCount — overrides book.chapterCount (e.g. a cached count)
// Returns { elapsed, total, remaining, percent, measured } or null when the
// book has no usable duration. `measured` is true when every chapter has a
// measured duration; otherwise chapters are estimated as equal slices.
export function bookAudioProgress(book, position, chapterCount = book?.chapterCount) {
  if (!book || !position || position.chapterIndex === undefined || position.chapterIndex === null) return null;
  const durations = chapterDurationsFor(book, chapterCount);
  const chapterTime = Math.max(0, Number(position.timestamp ?? position.currentTime ?? 0) || 0);
  let total;
  let elapsed;
  if (durations) {
    total = durations.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) return null;
    const index = Math.max(0, Math.min(durations.length - 1, Number(position.chapterIndex) || 0));
    const before = durations.slice(0, index).reduce((sum, value) => sum + value, 0);
    elapsed = Math.min(total, before + Math.min(durations[index] || 0, chapterTime));
  } else {
    total = Number(book.totalDuration);
    const count = Number(chapterCount);
    if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count <= 0) return null;
    const perChapter = total / count;
    const index = Math.max(0, Math.min(count - 1, Number(position.chapterIndex) || 0));
    elapsed = Math.min(total, index * perChapter + Math.min(perChapter, chapterTime));
  }
  if (position.finished) {
    return { elapsed: total, total, remaining: 0, percent: 100, measured: Boolean(durations) };
  }
  return {
    elapsed,
    total,
    remaining: Math.max(0, total - elapsed),
    percent: clampPercent(elapsed, total),
    measured: Boolean(durations)
  };
}

// Listening time left: remaining 1x audio divided by the effective speed.
export function timeLeftAtSpeed(remainingAudioSeconds, speed) {
  if (remainingAudioSeconds === null || remainingAudioSeconds === undefined) return null;
  const remaining = Number(remainingAudioSeconds);
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  return remaining / effectiveSpeed(speed);
}

// "9h 12m left" or "9h 12m left at 1.25×".
//   options.referenceSpeed — the speed already stated elsewhere on screen
//     (the library sort line). The suffix is added only when the book's own
//     speed differs from it. Omit it to always state the speed.
//   options.withSpeed — false never states the speed.
export function timeLeftLabel(seconds, speed, { referenceSpeed = null, withSpeed = true } = {}) {
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value === 0) return 'Finished';
  const duration = formatDuration(value);
  const stateSpeed = withSpeed && (referenceSpeed === null || referenceSpeed === undefined || !sameSpeed(speed, referenceSpeed));
  return stateSpeed ? `${duration} left at ${formatSpeed(speed)}` : `${duration} left`;
}

// One call for every surface: the book's progress plus its time left at the
// effective speed. Returns null when the book has no usable duration.
export function bookTimeLeft(book, position, speed, chapterCount = book?.chapterCount) {
  const progress = bookAudioProgress(book, position, chapterCount);
  if (!progress) return null;
  const rate = effectiveSpeed(speed);
  return {
    ...progress,
    speed: rate,
    timeLeft: timeLeftAtSpeed(progress.remaining, rate)
  };
}

// "Ch 12 of 50" for a narrative chapter; the section name otherwise.
export function shortChapterContext(context) {
  return String(context || '').replace(/^Chapter (\d+) of (\d+)$/, 'Ch $1 of $2');
}
