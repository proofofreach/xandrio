const DEFAULT_LOOKAHEAD_CHAPTERS = 3;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
// A session is keyed by a caller-influenced string (see
// playback-runway-prefetch-session-key-random-per-request.md). Even with a
// stable per-caller key, a large or hostile fleet of distinct callers could
// still grow `sessions`/`expiryTimers` without bound before their 30-minute
// TTL retires them, so cap the map and evict the least-recently-observed
// session to make room, the same way an LRU cache would.
const DEFAULT_MAX_SESSIONS = 500;
const {
  GENERATION_ORIGIN,
  GENERATION_PRIORITY
} = require('./audio-generation-intent');

function playableChapter(chapter) {
  return String(chapter?.text || '').trim().length >= 20;
}

function createPlaybackPrefetchCoordinator({
  getChapters,
  prepareChapter,
  cancelChapters = async () => {},
  isDeleted = () => false,
  isPlayableChapter = playableChapter,
  lookaheadChapters = DEFAULT_LOOKAHEAD_CHAPTERS,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  now = Date.now,
  onError = () => {}
} = {}) {
  if (typeof getChapters !== 'function' || typeof prepareChapter !== 'function') {
    throw new TypeError('Playback prefetch requires chapter loading and preparation');
  }

  const sessions = new Map();
  const expiryTimers = new Map();
  const observationVersions = new Map();
  const inflight = new Map();
  const windowSize = Math.max(1, Number(lookaheadChapters) || DEFAULT_LOOKAHEAD_CHAPTERS);
  const boundedMaxSessions = Math.max(1, Number(maxSessions) || DEFAULT_MAX_SESSIONS);
  let observationSequence = 0;

  function dropSession(key) {
    sessions.delete(key);
    observationVersions.delete(key);
    clearTimeout(expiryTimers.get(key));
    expiryTimers.delete(key);
  }

  function pruneSessions() {
    const cutoff = now() - Math.max(1, Number(sessionTtlMs) || DEFAULT_SESSION_TTL_MS);
    for (const [key, session] of sessions) {
      if (session.updatedAt < cutoff) dropSession(key);
    }
  }

  // Called just before inserting a session so the map never exceeds its cap.
  // Re-observing an existing session doesn't grow the map, so it never needs
  // to evict on its own account. Evicts the least-recently-observed
  // session(s) first, mirroring a standard LRU cache.
  function evictExcessSessions(incomingSessionId) {
    if (sessions.has(incomingSessionId)) return;
    while (sessions.size >= boundedMaxSessions) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, session] of sessions) {
        if (session.updatedAt < oldestAt) {
          oldestAt = session.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      dropSession(oldestKey);
    }
  }

  function targetKey(session) {
    return `${session.bookId}\u0000${session.tier}\u0000${session.variantKey}`;
  }

  function chapterTargetKey(target, chapterIndex) {
    return `${targetKey(target)}\u0000${chapterIndex}`;
  }

  function desiredWindows() {
    const targets = new Map();
    for (const session of sessions.values()) {
      const key = targetKey(session);
      if (!targets.has(key)) {
        targets.set(key, {
          bookId: session.bookId,
          tier: session.tier,
          variantKey: session.variantKey,
          voice: session.voice,
          chunkSize: session.chunkSize,
          chapterIndexes: new Set()
        });
      }
      const target = targets.get(key);
      for (const chapterIndex of session.window) target.chapterIndexes.add(chapterIndex);
    }
    return targets;
  }

  function forwardWindow(chapters, chapterIndex) {
    const window = [];
    for (let index = chapterIndex + 1; index < chapters.length && window.length < windowSize; index += 1) {
      if (isPlayableChapter(chapters[index])) window.push(index);
    }
    return window;
  }

  function schedule(request) {
    const key = chapterTargetKey(request, request.chapterIndex);
    if (inflight.has(key)) return;
    const controller = new AbortController();
    const preparedRequest = { ...request, signal: controller.signal };
    let work;
    try {
      work = Promise.resolve(prepareChapter(preparedRequest));
    } catch (error) {
      onError(error, request);
      return;
    }
    const entry = { controller, request, work };
    inflight.set(key, entry);
    work.catch(error => {
      if (error?.name !== 'AbortError') onError(error, request);
    }).finally(async () => {
      if (inflight.get(key) !== entry) return;
      inflight.delete(key);
      const desiredTarget = desiredWindows().get(targetKey(request));
      const stillDesired = desiredTarget?.chapterIndexes.has(request.chapterIndex);
      if (!stillDesired) {
        await cancelChapters({
          bookId: request.bookId,
          tier: request.tier,
          variantKey: request.variantKey,
          chapterIndexes: [request.chapterIndex],
          origin: GENERATION_ORIGIN.PLAYBACK_LOOKAHEAD
        });
      } else if (controller.signal.aborted) {
        schedule({
          ...request,
          voice: desiredTarget.voice,
          chunkSize: desiredTarget.chunkSize
        });
      }
    }).catch(error => {
      if (error?.name !== 'AbortError') onError(error, request);
    });
  }

  async function reconcile(before, after) {
    const scheduledByTarget = new Map();
    for (const [key, target] of after) {
      const previous = before.get(key)?.chapterIndexes || new Set();
      const added = [...target.chapterIndexes].filter(index => !previous.has(index));
      scheduledByTarget.set(key, added);
      for (const chapterIndex of added) {
        schedule({
          bookId: target.bookId,
          chapterIndex,
          priority: GENERATION_PRIORITY.LOOKAHEAD,
          origin: GENERATION_ORIGIN.PLAYBACK_LOOKAHEAD,
          tier: target.tier,
          variantKey: target.variantKey,
          voice: target.voice,
          chunkSize: target.chunkSize
        });
      }
    }
    for (const [key, target] of before) {
      const desired = after.get(key)?.chapterIndexes || new Set();
      const released = [...target.chapterIndexes].filter(index => !desired.has(index));
      if (released.length === 0) continue;
      for (const chapterIndex of released) {
        inflight.get(chapterTargetKey(target, chapterIndex))?.controller.abort();
      }
      try {
        await cancelChapters({
          bookId: target.bookId,
          tier: target.tier,
          variantKey: target.variantKey,
          chapterIndexes: released,
          origin: GENERATION_ORIGIN.PLAYBACK_LOOKAHEAD
        });
      } catch (error) {
        onError(error, {
          bookId: target.bookId,
          chapterIndexes: released,
          variantKey: target.variantKey
        });
      }
    }
    return scheduledByTarget;
  }

  async function observe({
    bookId,
    chapterIndex,
    sessionId,
    tier = 'active',
    variantKey = tier,
    voice = null,
    chunkSize = null
  } = {}) {
    if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0 || !sessionId || isDeleted(bookId)) {
      return { window: [], scheduled: [] };
    }
    const observationVersion = ++observationSequence;
    observationVersions.set(sessionId, observationVersion);
    const chapters = await getChapters(bookId);
    if (observationVersions.get(sessionId) !== observationVersion) {
      return { window: [], scheduled: [], stale: true };
    }
    if (!Array.isArray(chapters) || chapterIndex >= chapters.length) {
      return { window: [], scheduled: [] };
    }

    const before = desiredWindows();
    pruneSessions();
    evictExcessSessions(sessionId);
    const window = forwardWindow(chapters, chapterIndex);
    sessions.set(sessionId, {
      bookId,
      tier,
      variantKey,
      voice,
      chunkSize,
      window,
      updatedAt: now()
    });
    clearTimeout(expiryTimers.get(sessionId));
    const observedAt = sessions.get(sessionId).updatedAt;
    const timer = setTimeout(() => {
      const session = sessions.get(sessionId);
      if (!session || session.updatedAt !== observedAt) return;
      void removeSession(sessionId).catch(error => onError(error, {
        sessionId,
        bookId: session.bookId,
        variantKey: session.variantKey
      }));
    }, Math.max(1, Number(sessionTtlMs) || DEFAULT_SESSION_TTL_MS));
    timer.unref?.();
    expiryTimers.set(sessionId, timer);
    const after = desiredWindows();
    const scheduledByTarget = await reconcile(before, after);
    const key = targetKey({ bookId, tier, variantKey });
    const scheduled = scheduledByTarget.get(key) || [];
    return { window, scheduled };
  }

  function removeBook(bookId) {
    const before = desiredWindows();
    for (const [key, session] of sessions) {
      if (session.bookId === bookId) dropSession(key);
    }
    return reconcile(before, desiredWindows());
  }

  function removeSession(sessionId) {
    const before = desiredWindows();
    dropSession(sessionId);
    return reconcile(before, desiredWindows());
  }

  return { observe, removeBook, removeSession, sessionCount: () => sessions.size };
}

module.exports = {
  DEFAULT_LOOKAHEAD_CHAPTERS,
  DEFAULT_SESSION_TTL_MS,
  createPlaybackPrefetchCoordinator
};
