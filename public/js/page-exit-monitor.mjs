// Detects that the previous page session was killed rather than closed.
//
// iOS reloads a web app whose content process crashed or ran out of memory,
// and after two crashes shows "A problem repeatedly occurred". The page gets
// no event when that happens, so the evidence has to be left beforehand: a
// small heartbeat in localStorage that a clean exit (pagehide) marks as ended.
// On the next launch, a heartbeat that is recent and was never ended means the
// previous session died. The result is a count only, reported through the
// anonymous playback-health aggregate.

const KEY = 'xandrio_page_session';
const BEAT_MS = 5000;
// A foreground heartbeat this close to the next launch means the page died in
// front of the listener. Older ones are ordinary closes the OS never reported.
const FOREGROUND_WINDOW_MS = 30000;
const BACKGROUND_WINDOW_MS = 2 * 60 * 1000;

export function classifyPreviousExit(previous, nowMs) {
  if (!previous || typeof previous !== 'object' || previous.ended) return null;
  const beatAt = Number(previous.beatAt);
  if (!Number.isFinite(beatAt) || beatAt > nowMs) return null;
  const age = nowMs - beatAt;
  const suffix = previous.offlineWork ? '-offline-work' : '';
  if (previous.visible && age <= FOREGROUND_WINDOW_MS) return `page-crash${suffix}`;
  // A hidden page is normally suspended, not killed. One that was playing
  // audio keeps running, so its heartbeat keeps arriving until it dies.
  if (!previous.visible && previous.playing && age <= BACKGROUND_WINDOW_MS) {
    return `page-killed-playing${suffix}`;
  }
  return null;
}

export function startPageExitMonitor({
  storage = globalThis.localStorage,
  now = () => Date.now(),
  isVisible = () => globalThis.document?.visibilityState !== 'hidden',
  isPlaying = () => false,
  offlineWork = () => false,
  report = () => {},
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  target = globalThis
} = {}) {
  const read = () => {
    try { return JSON.parse(storage?.getItem(KEY) || 'null'); } catch { return null; }
  };
  const write = value => {
    try { storage?.setItem(KEY, JSON.stringify(value)); } catch {}
  };
  const exit = classifyPreviousExit(read(), now());
  if (exit) report(exit);

  let ended = false;
  const beat = () => {
    write({
      beatAt: now(),
      visible: Boolean(isVisible()),
      playing: Boolean(isPlaying()),
      offlineWork: Boolean(offlineWork()),
      ended
    });
  };
  beat();
  setIntervalFn?.(() => { if (!ended) beat(); }, BEAT_MS);
  target.addEventListener?.('pagehide', () => { ended = true; beat(); });
  // A page restored from the back-forward cache is live again.
  target.addEventListener?.('pageshow', () => { ended = false; beat(); });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!ended) beat(); });
  return { beat, exit };
}
