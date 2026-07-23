const DEFAULT_PROVISIONAL_MIN_LISTEN_MS = 45_000;
const DEFAULT_PROVISIONAL_MIN_POSITION_SECONDS = 45;

function positionSeconds(position) {
  return Math.max(0, Number(position?.totalEstimatedTime || position?.currentTime) || 0);
}

function enginePosition(engine) {
  return engine?.getPosition?.() || null;
}

/**
 * Owns the mutable playback session while engines remain small media adapters.
 * An engine implements loadChapter, play, pause, getPosition, seek, and
 * dispose. The app chooses engines; this module serializes their handoff.
 */
export function createPlaybackSession(options = {}) {
  const now = options.now || Date.now;
  const onStateChange = options.onStateChange || (() => {});
  const provisionalMinListenMs = options.provisionalMinListenMs ?? DEFAULT_PROVISIONAL_MIN_LISTEN_MS;
  const provisionalMinPositionSeconds = options.provisionalMinPositionSeconds ?? DEFAULT_PROVISIONAL_MIN_POSITION_SECONDS;
  let revision = 0;
  let queue = Promise.resolve();
  let disposed = false;
  let provisional = null;
  const engineClaims = new Map();
  const releasedEngines = new WeakSet();
  const state = {
    book: null,
    chapterIndex: 0,
    engine: null,
    backend: null,
    finished: false
  };

  function snapshot() {
    return {
      ...state,
      provisionalForward: provisional ? { ...provisional } : null,
      disposed
    };
  }

  function publish() {
    onStateChange(snapshot());
  }

  function isObjectEngine(engine) {
    return engine !== null && (typeof engine === 'object' || typeof engine === 'function');
  }

  function release(engine, force = false) {
    if (!engine || (isObjectEngine(engine) && releasedEngines.has(engine))) return;
    if (!force && (engine === state.engine || engineClaims.has(engine))) return;
    if (isObjectEngine(engine)) releasedEngines.add(engine);
    try { engine.pause?.(); } catch {}
    try { engine.dispose?.(); } catch {}
  }

  function claimTransitionEngine(transition, engine) {
    if (!engine || transition.engine === engine) return;
    transition.engine = engine;
    engineClaims.set(engine, (engineClaims.get(engine) || 0) + 1);
  }

  function finishTransition(transition) {
    const engine = transition.engine;
    if (!engine) return;
    transition.engine = null;
    const claims = engineClaims.get(engine) || 0;
    if (claims <= 1) engineClaims.delete(engine);
    else engineClaims.set(engine, claims - 1);
    release(engine);
  }

  function clearProvisionalForward() {
    provisional = null;
  }

  function setBook(book, options = {}) {
    revision += 1;
    state.book = book || null;
    state.chapterIndex = Number.isInteger(options.chapterIndex) ? options.chapterIndex : 0;
    state.finished = Boolean(options.finished);
    clearProvisionalForward();
    publish();
    return snapshot();
  }

  function setFinished(finished) {
    state.finished = Boolean(finished);
    publish();
  }

  function adoptEngine(engine, backend = engine?.backend || null) {
    state.engine = engine || null;
    state.backend = backend || null;
    publish();
    return snapshot();
  }

  function markProvisionalForward(fromChapter, toChapter) {
    if (!state.book || !Number.isInteger(fromChapter) || !Number.isInteger(toChapter) || toChapter <= fromChapter) {
      clearProvisionalForward();
      return;
    }
    provisional = {
      bookId: state.book.id,
      fromChapter,
      toChapter,
      startedAt: now()
    };
  }

  function isCheckpointEligible(position, options = {}) {
    if (options.force || !provisional || !state.book) return true;
    if (provisional.bookId !== state.book.id || provisional.toChapter !== state.chapterIndex) return true;
    const listenedMs = now() - provisional.startedAt;
    if (listenedMs >= provisionalMinListenMs || positionSeconds(position) >= provisionalMinPositionSeconds) {
      clearProvisionalForward();
      return true;
    }
    return false;
  }

  function buildCheckpoint(options = {}) {
    const position = enginePosition(state.engine);
    if (!state.book || !position || !isCheckpointEligible(position, options)) return null;
    const chunkIndex = Number.isInteger(position.chunkIndex)
      ? position.chunkIndex
      : (position.chunk || 0);
    return {
      bookId: state.book.id,
      chapterIndex: state.chapterIndex,
      timestamp: positionSeconds(position),
      chunk: chunkIndex,
      chunkIndex,
      chunkTime: Math.max(0, Number(position.chunkTime) || 0),
      wasPlaying: Boolean(state.engine?.isPlaying),
      playbackRate: options.playbackRate,
      finished: Boolean(options.finished) || state.finished,
      updatedAt: now()
    };
  }

  function isCurrent(id) {
    return !disposed && id === revision;
  }

  async function commitTransition(transition) {
    const { id, request } = transition;
    if (!isCurrent(id)) return { stale: true, snapshot: snapshot() };
    const incoming = request.createEngine
      ? await request.createEngine()
      : transition.engine;
    if (request.createEngine) claimTransitionEngine(transition, incoming);
    if (!incoming) throw new Error('Playback transition requires an engine');
    if (!isCurrent(id)) return { stale: true, snapshot: snapshot() };

    const old = state.engine;
    const shouldResume = request.play === undefined ? Boolean(old?.isPlaying) : Boolean(request.play);
    await incoming.loadChapter(request.book.id, request.chapterIndex);
    if (!isCurrent(id)) return { stale: true, snapshot: snapshot() };

    const handoffPosition = request.position || (request.preservePosition ? enginePosition(old) : null);
    const seekTo = positionSeconds(handoffPosition);
    if (incoming !== old && seekTo > 0) await incoming.seek(seekTo);
    if (!isCurrent(id)) return { stale: true, snapshot: snapshot() };
    if (shouldResume) await incoming.play();
    if (!isCurrent(id)) return { stale: true, snapshot: snapshot() };

    if (incoming !== old) {
      try { old?.pause?.(); } catch {}
    }
    state.engine = incoming;
    state.backend = request.backend || incoming.backend || null;
    state.book = request.book;
    state.chapterIndex = request.chapterIndex;
    if (request.finished !== undefined) state.finished = Boolean(request.finished);
    if (request.commitImmediately || (provisional && provisional.toChapter !== request.chapterIndex)) clearProvisionalForward();
    if (incoming !== old && request.disposePrevious !== false) release(old);
    publish();
    return { stale: false, snapshot: snapshot() };
  }

  function transitionTo(request = {}) {
    if (!request.book || !Number.isInteger(request.chapterIndex)) {
      return Promise.reject(new Error('Playback transition requires a book and chapter index'));
    }
    if (disposed) return Promise.resolve({ stale: true, disposed: true, snapshot: snapshot() });

    const id = ++revision;
    const transition = { id, request, engine: null };
    if (!request.createEngine) claimTransitionEngine(transition, request.engine);
    state.book = request.book;
    state.chapterIndex = request.chapterIndex;
    if (request.provisionalForward) markProvisionalForward(request.fromChapter, request.chapterIndex);
    else if (request.commitImmediately || (provisional && request.chapterIndex !== provisional.toChapter)) clearProvisionalForward();
    publish();

    const run = () => commitTransition(transition);
    const result = queue.then(run, run).finally(() => finishTransition(transition));
    queue = result.catch(() => undefined);
    return result;
  }

  function handoffTo(request = {}) {
    if (!state.book) return Promise.resolve({ stale: true, snapshot: snapshot() });
    return transitionTo({
      ...request,
      book: state.book,
      chapterIndex: state.chapterIndex,
      position: request.position || enginePosition(state.engine),
      play: request.play === undefined ? Boolean(state.engine?.isPlaying) : request.play
    });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    revision += 1;
    clearProvisionalForward();
    const engine = state.engine;
    state.engine = null;
    state.backend = null;
    publish();
    release(engine, true);
    await queue.catch(() => undefined);
  }

  return {
    get snapshot() { return snapshot(); },
    setBook,
    setFinished,
    adoptEngine,
    transitionTo,
    handoffTo,
    markProvisionalForward,
    clearProvisionalForward,
    isCheckpointEligible,
    buildCheckpoint,
    dispose
  };
}
