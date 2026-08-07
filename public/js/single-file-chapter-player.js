/**
 * Native-audio engine used for continuous online and downloaded playback.
 * It implements the same playback adapter contract used by ChunkPlayer.
 */

// A media element that neither fires `canplay`/`loadedmetadata` nor `error`
// (backgrounded iOS tab, silently stalled response) would otherwise leave
// loadChapter() pending forever with the loading overlay stuck up.
//
// This is the single client-side abandonment deadline. The server's HLS
// readiness timeout is derived from it (see lib/hls-audio-stream.js) so that a
// still-connected client never has its in-flight encoder killed underneath it.
export const CLIENT_LOAD_DEADLINE_MS = 30000;
const LOAD_TIMEOUT_MS = CLIENT_LOAD_DEADLINE_MS;

// How many canonical request tuples keep a remembered session id. Small: a
// listener only ever revisits the current chapter's handful of offsets.
const MAX_REMEMBERED_ATTEMPTS = 16;

// Mid-playback death is silent. A media element only raises `error` when the
// *load* fails; once playing, a transport that stops delivering data leaves
// iOS sitting in `waiting` with no further events, forever. That is how a
// listener whose HLS session had been idle-evicted spent 34 minutes in silence
// while the app kept polling as if nothing were wrong — the player never
// learned the stream was dead, so none of the recovery machinery ran.
//
// Liveness is "the playhead advanced, or the buffer grew". Either one means
// the transport is alive: a player parked at the live edge of a still-growing
// playlist buffers without advancing, and a player draining a full buffer
// advances without downloading. Only when *both* freeze has playback stopped.
const STALL_PROBE_INTERVAL_MS = 2000;
// Comfortably longer than any legitimate rebuffer, because the recovery this
// arms is a reload. The server-side runway gate (lib/routes/playback-routes.js)
// means a stream is only opened once its audio exists, so a freeze this long is
// a broken transport rather than narration that has not been generated yet.
const STALL_TIMEOUT_MS = 20000;
// Below this, a difference is measurement noise rather than progress.
const PROGRESS_EPSILON_SECONDS = 0.05;

// Chapter-mapping timeline refresh, and how many ticks it skips while the
// document is hidden (2s visible, 10s backgrounded).
const TIMELINE_POLL_INTERVAL_MS = 2000;
const TIMELINE_HIDDEN_POLL_RATIO = 5;

// How long before the end of a finite chapter the next one is pulled into
// memory.
//
// A per-chapter source (a download, or the streamed chapter fallback) has to
// replace the media element's src at every chapter boundary. Doing that *after*
// `ended` is what broke lock-screen listening: once playback stops on a locked
// phone, iOS suspends the page and its service worker, so the new source never
// loads. The element then sits with a src and no data, autoplay never fires,
// and the lock-screen play button calls play() on an element that cannot fetch
// anything — silence until the app is foregrounded again.
//
// While the current chapter is still playing the page is alive and allowed to
// use the network, so the next chapter is fetched then and handed to the
// element as an object URL, which needs neither network nor service worker at
// the boundary. The lead has to cover a whole chapter download on a slow
// connection; the fetch is cancelled implicitly by a chapter change.
const CHAPTER_PREWARM_LEAD_SECONDS = 45;
const { DisposableScope, LifecycleCancelledError, waitForMediaEvents } = globalThis.XandrioLifecycle || {};

export class SingleFileChapterPlayer {
  constructor(audio, options = {}) {
    this.audio = audio;
    this.onTimeUpdate = options.onTimeUpdate || null;
    this.onChunkChange = options.onChunkChange || null;
    this.onChapterEnd = options.onChapterEnd || null;
    this.onError = options.onError || null;
    this.onReady = options.onReady || null;
    this.onWaiting = options.onWaiting || null;
    this.onPreparing = options.onPreparing || null;
    this.onPlaybackChange = options.onPlaybackChange || null;
    this.onChapterTransition = options.onChapterTransition || null;
    this.onDiagnosticEvent = options.onDiagnosticEvent || null;
    this.cryptoProvider = options.cryptoProvider || globalThis.crypto || null;
    this.isIOSLike = options.isIOSLike || (() => false);
    this.getEstimatedDuration = options.getEstimatedDuration || (() => 0);
    this.getChapterCount = options.getChapterCount || (() => 0);
    this.getContinuousEndChapter = options.getContinuousEndChapter || (() => null);
    this.resolveServedTier = options.resolveServedTier || null;
    this.resolveOfflineAudioUrl = options.resolveOfflineAudioUrl || null;
    // Resolves the media URL for a chapter that can be fetched ahead of time,
    // or null when the next chapter has no such source. Only sources that are
    // already on the device are worth pre-warming; see _prewarmChapter.
    this.resolveNextChapterUrl = options.resolveNextChapterUrl || null;
    this.onChapterAdvance = options.onChapterAdvance || null;
    this.prewarmLeadSeconds = Number(options.prewarmLeadSeconds) > 0
      ? Number(options.prewarmLeadSeconds)
      : CHAPTER_PREWARM_LEAD_SECONDS;
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis) || null;
    this.preferStandardAudio = Boolean(options.preferStandardAudio);
    this.preparePlaybackRunway = options.preparePlaybackRunway !== false;
    this.runwayPollIntervalMs = Number(options.runwayPollIntervalMs) > 0
      ? Number(options.runwayPollIntervalMs)
      : 1000;
    this.loadTimeoutMs = Number(options.loadTimeoutMs) > 0 ? Number(options.loadTimeoutMs) : LOAD_TIMEOUT_MS;
    this.playTimeoutMs = Number(options.playTimeoutMs) > 0 ? Number(options.playTimeoutMs) : 10000;
    this.playProgressTimeoutMs = Number(options.playProgressTimeoutMs) > 0
      ? Number(options.playProgressTimeoutMs)
      : 3000;
    this.stallTimeoutMs = Number(options.stallTimeoutMs) >= 0
      ? Number(options.stallTimeoutMs)
      : STALL_TIMEOUT_MS;
    this.stallProbeIntervalMs = Number(options.stallProbeIntervalMs) > 0
      ? Number(options.stallProbeIntervalMs)
      : STALL_PROBE_INTERVAL_MS;
    this.clock = options.clock || globalThis;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.backend = 'single-file';
    this.activeSource = null;
    this.servedTier = null;
    this.supportsChunkPositionRestore = false;
    this.supportsNativeMediaSession = true;
    this.bookId = null;
    this.chapterIndex = null;
    this.startChapterIndex = null;
    this.isContinuous = false;
    this.streamStartOffset = 0;
    this.requestedStartOffset = 0;
    this.playbackSessionId = null;
    this.playbackOwnerId = this._newPlaybackSessionId();
    this.endChapterIndex = null;
    // Canonical request tuple -> session id. The server keys an HLS session on
    // the tuple *including* this id, so minting a fresh one per attempt made
    // every retry spawn a new ffmpeg encoder. Remembering the id per tuple lets
    // an identical retry join the session already being prepared, while a
    // genuine relocation (different chapter/tier/offset/end) still gets its own.
    // The id stays a per-client random value, so sessions are never shared
    // across accounts.
    this._attemptSessions = new Map();
    this._timelineDurations = new Map();
    this.totalChunks = 1;
    this.currentChunk = 0;
    this._isPlaying = false;
    this._volume = 1;
    this.playbackRate = 1;
    // Incremented on every loadChapter()/dispose(). Async chains capture it
    // on entry and bail after each await if a newer chapter has taken over,
    // so an in-flight load can't fire onReady for a superseded chapter.
    // Mirrors the same guard in ChunkPlayer.
    this._generation = 0;
    // Tears down the in-flight loadChapter() wait, if any.
    this._loadWait = null;
    this._runwayController = null;
    this._isLoading = false;
    this._eventScope = null;
    this._playWait = null;
    this._playProgressWait = null;
    this._pauseReason = null;
    this._playReason = null;
    // Disposer for the running stall probe, and the last observed liveness
    // sample it compares against.
    this._stallWatchdog = null;
    this._stallMark = null;
    this._lastDiagnosticTimeUpdateAt = 0;
    // The next chapter, already downloaded into an object URL, and the chapter
    // index whose fetch is in flight. Both are cleared by any chapter change.
    this._prewarm = null;
    this._prewarmInFlight = null;
    this._prewarmController = null;
    // A chapter that has no local source, or whose fetch failed. Remembered
    // because `timeupdate` fires several times a second: without it every one
    // of them would re-run the cache lookup for a chapter that is not there.
    this._prewarmDeclined = null;
    // Object URL currently assigned to the media element, so it can be revoked
    // once the element has moved on from it.
    this._activeObjectUrl = null;
    this._boundTimeUpdate = this._handleTimeUpdate.bind(this);
    this._boundEnded = this._handleEnded.bind(this);
    this._boundError = this._handleError.bind(this);
    this._boundNativePlay = this._handleNativePlay.bind(this);
    this._boundNativePause = this._handleNativePause.bind(this);
    this._boundMediaState = this._handleMediaState.bind(this);
  }

  /**
   * @param {string} bookId
   * @param {number} chapterIndex
   * @param {{startOffsetSeconds?: number, servedTier?: string, endChapterIndex?: number}} [options]
   *   The exact canonical tuple to open. Recovery passes an immutable snapshot
   *   here so the transport starts *at* the resume position. Loading at zero and
   *   seeking afterwards relocated the stream, which minted a second server
   *   session for every retry — the churn behind the production incident.
   */
  async loadChapter(bookId, chapterIndex, options = {}) {
    const gen = ++this._generation;
    this._cancelRunwayPreparation();
    // An explicit load supersedes whatever was pre-warmed for the chapter that
    // would have followed the one being left behind.
    this._releasePrewarm();
    this.pause();
    const requestedOffset = Number(options.startOffsetSeconds);
    const startOffsetSeconds = Number.isFinite(requestedOffset) && requestedOffset > 0
      ? requestedOffset
      : 0;
    this.bookId = bookId;
    this.chapterIndex = chapterIndex;
    this.startChapterIndex = chapterIndex;
    this.isContinuous = false;
    // The transport begins at this offset, so chapter time maps back through it
    // and a seek to the same position resolves to the buffered start instead of
    // relocating. Overwritten below if a finite chapter source is used instead.
    this.streamStartOffset = startOffsetSeconds;
    this.requestedStartOffset = startOffsetSeconds;
    this.playbackSessionId = null;
    this.endChapterIndex = Number.isInteger(options.endChapterIndex)
      ? this._normalizeEndChapter(options.endChapterIndex, chapterIndex)
      : this._normalizeEndChapter(
        this.getContinuousEndChapter(bookId, chapterIndex),
        chapterIndex
      );
    this._timelineDurations.clear();
    this.currentChunk = 0;
    this.totalChunks = 1;
    this._detach();
    this.audio.preload = 'auto';
    this.audio.volume = this._volume;
    this.audio.playbackRate = this.playbackRate;
    this._isLoading = true;
    this.onWaiting?.('Loading audio…');
    const encodedBookId = encodeURIComponent(bookId);
    const standardUrl = this._standardChapterUrl(bookId, chapterIndex);
    let tierQuery = '';
    this.servedTier = null;
    // A recovery snapshot pins the tier it captured, so a retry cannot drift on
    // to a different one and thereby request a different canonical tuple.
    const pinnedTier = options.servedTier === 'instant' || options.servedTier === 'premium'
      ? options.servedTier
      : null;
    if (pinnedTier) {
      this.servedTier = pinnedTier;
      tierQuery = `?tier=${encodeURIComponent(pinnedTier)}`;
    } else if (!this.preferStandardAudio && this.resolveServedTier) {
      try {
        const tier = await this.resolveServedTier(bookId, chapterIndex);
        if (gen !== this._generation) return;
        if (tier === 'instant' || tier === 'premium') {
          this.servedTier = tier;
          tierQuery = `?tier=${encodeURIComponent(tier)}`;
        }
      } catch {
        // The stream can still resolve its own default tier.
      }
    }
    if (!this.preferStandardAudio && this.preparePlaybackRunway && this.fetch) {
      this.onWaiting?.('Preparing uninterrupted audio…');
      try {
        const runway = await this._waitForPlaybackRunway({
          encodedBookId,
          chapterIndex,
          tierQuery,
          startOffsetSeconds,
          endChapterIndex: this.endChapterIndex,
          generation: gen
        });
        if (
          !pinnedTier
          && (runway?.servedTier === 'instant' || runway?.servedTier === 'premium')
        ) {
          this.servedTier = runway.servedTier;
          tierQuery = `?tier=${encodeURIComponent(runway.servedTier)}`;
        }
      } catch (error) {
        if (gen === this._generation) {
          this._isLoading = false;
          if (!error?.cancelled) this.onError?.(error);
        }
        throw error;
      }
      if (gen !== this._generation) {
        throw new LifecycleCancelledError('Chapter runway preparation cancelled');
      }
    }
    this._attach();
    const continuousCandidates = this._continuousCandidates(
      encodedBookId,
      chapterIndex,
      tierQuery,
      startOffsetSeconds
    );
    const sourceCandidates = this.preferStandardAudio
      ? [{ url: standardUrl, continuous: false }]
      : [
          ...continuousCandidates,
          { url: `${standardUrl}${tierQuery}`, continuous: false }
        ];
    let lastError = null;
    try {
      for (const candidate of sourceCandidates) {
        if (gen !== this._generation) return;
        const wait = waitForMediaEvents(this.audio, {
          resolveEvents: ['loadedmetadata', 'canplay'],
          rejectEvents: ['error'],
          timeoutMs: this.loadTimeoutMs,
          timeoutError: () => {
            const error = this._audioError();
            error.code = 'MEDIA_LOAD_TIMEOUT';
            return error;
          },
          eventError: () => this._audioError(),
          cancelledError: () => new LifecycleCancelledError('Chapter load cancelled')
        });
        this._loadWait = wait;
        this.audio.src = candidate.url;
        // The element has let go of the pre-warmed blob it may have been
        // playing; holding the object URL any longer only pins its memory.
        this._revokeObjectUrl(this._activeObjectUrl);
        this._emitDiagnostic('source-load', {
          sourceKind: candidate.continuous ? 'continuous' : 'chapter'
        });
        try {
          this.audio.load();
          await wait.promise;
          this.activeSource = candidate.url;
          this.isContinuous = candidate.continuous;
          this.streamStartOffset = candidate.startOffset || 0;
          this.playbackSessionId = candidate.sessionId || null;
          this.backend = candidate.continuous ? 'audio-stream' : 'single-file';
          if (candidate.continuous) this._startTimelinePolling();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (error?.cancelled || gen !== this._generation) throw error;
        } finally {
          if (this._loadWait === wait) this._loadWait = null;
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      if (gen === this._generation && !error?.cancelled) {
        await this._classifyLoadFailure(error, sourceCandidates);
        if (gen !== this._generation) throw error;
        this.onError?.(error);
      }
      throw error;
    } finally {
      if (gen === this._generation) this._isLoading = false;
    }
    if (gen !== this._generation) return;
    this.onReady?.();
    this._handleTimeUpdate();
  }

  _attach() {
    this._detach();
    this._eventScope = new DisposableScope();
    this._eventScope.listen(this.audio, 'timeupdate', this._boundTimeUpdate);
    this._eventScope.listen(this.audio, 'ended', this._boundEnded);
    this._eventScope.listen(this.audio, 'error', this._boundError);
    this._eventScope.listen(this.audio, 'play', this._boundNativePlay);
    this._eventScope.listen(this.audio, 'playing', this._boundNativePlay);
    this._eventScope.listen(this.audio, 'pause', this._boundNativePause);
    for (const eventName of ['waiting', 'stalled', 'suspend', 'abort', 'emptied']) {
      this._eventScope.listen(this.audio, eventName, this._boundMediaState);
    }
    // Re-attaching mid-playback (a relocation, for instance) tore down the
    // previous scope and with it the stall probe. A fresh `playing` event is
    // not guaranteed to follow, so restore the probe here rather than leaving
    // an already-playing element unwatched.
    if (this._isPlaying) this._startStallWatchdog();
  }

  _detach() {
    this._stopStallWatchdog();
    this._loadWait?.cancel();
    this._loadWait = null;
    this._playWait?.cancel();
    this._playWait = null;
    this._playProgressWait?.cancel();
    this._playProgressWait = null;
    this._eventScope?.dispose();
    this._eventScope = null;
  }

  _waitForPlaybackProgress(startTime) {
    let settled = false;
    let timer = null;
    let resolveWait;
    let rejectWait;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      this.audio.removeEventListener('timeupdate', onTimeUpdate);
      this.audio.removeEventListener('ended', onTimeUpdate);
      this.audio.removeEventListener('error', onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const hasAdvanced = () => (
      this.audio.ended
      || (Number(this.audio.currentTime) || 0) - startTime >= 0.05
    );
    const onTimeUpdate = () => {
      if (hasAdvanced()) finish(resolveWait);
    };
    const onError = () => finish(rejectWait, this._audioError());
    const promise = new Promise((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
      this.audio.addEventListener('timeupdate', onTimeUpdate);
      this.audio.addEventListener('ended', onTimeUpdate);
      this.audio.addEventListener('error', onError);
      timer = setTimeout(() => {
        const error = new Error('Audio claimed to be playing but did not advance');
        error.code = 'MEDIA_PROGRESS_TIMEOUT';
        error.chapterTime = this.getCurrentTime();
        finish(reject, error);
      }, this.playProgressTimeoutMs);
      onTimeUpdate();
    });
    return {
      promise,
      cancel: () => finish(
        rejectWait,
        new LifecycleCancelledError('Playback progress wait cancelled')
      )
    };
  }

  _audioError() {
    const detail = this.audio.error && (this.audio.error.message || this.audio.error.code);
    return new Error(detail || 'Chapter audio playback failed');
  }

  _newPlaybackSessionId() {
    if (typeof this.cryptoProvider?.randomUUID === 'function') {
      return this.cryptoProvider.randomUUID();
    }
    if (typeof this.cryptoProvider?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      this.cryptoProvider.getRandomValues(bytes);
      // RFC 4122 version 4 / variant 1 bits. Keeping UUID shape also satisfies
      // the server's bounded playback-session identifier validation.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
      return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10).join('')
      ].join('-');
    }
    throw new Error('Secure playback session identity is unavailable');
  }

  _supportsNativeHls() {
    try {
      return this.isIOSLike()
        && Boolean(this.audio.canPlayType?.('application/vnd.apple.mpegurl'));
    } catch {
      return false;
    }
  }

  /**
   * Recover the reason a continuous source failed.
   *
   * A media element surfaces only a generic error — never the HTTP status — so
   * a server that is shedding load (429/503) is indistinguishable from a decode
   * failure. One small probe of the same URL recovers it, letting the app tell
   * the user to wait rather than retry straight back into the limit. Best
   * effort by design: any probe failure leaves the original error untouched.
   */
  async _classifyLoadFailure(error, sourceCandidates) {
    if (!this.fetch || !error || typeof error !== 'object') return;
    if (error.status !== undefined) return;
    const continuous = sourceCandidates.find(candidate => candidate.continuous);
    if (!continuous) return;
    try {
      const response = await this.fetch(continuous.url, { cache: 'no-store' });
      if (!response || response.ok) return;
      error.status = response.status;
      const retryAfter = Number(response.headers?.get?.('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        error.retryAfterSeconds = retryAfter;
      }
    } catch {
      // The probe is diagnostic only; its failure must not mask the real error.
    }
  }

  // Stable session id for one canonical request tuple. Reusing the id makes the
  // server's own session key repeat, so a retry joins the encoder already
  // running instead of starting — and rate-limiting — another one.
  _sessionIdForAttempt(attemptKey) {
    const remembered = this._attemptSessions.get(attemptKey);
    if (remembered) {
      // Refresh recency so the tuple in active use is the last to be dropped.
      this._attemptSessions.delete(attemptKey);
      this._attemptSessions.set(attemptKey, remembered);
      return remembered;
    }
    const sessionId = this._newPlaybackSessionId();
    this._attemptSessions.set(attemptKey, sessionId);
    while (this._attemptSessions.size > MAX_REMEMBERED_ATTEMPTS) {
      this._attemptSessions.delete(this._attemptSessions.keys().next().value);
    }
    return sessionId;
  }

  _normalizeEndChapter(value, startChapterIndex = this.chapterIndex) {
    if (value === null || value === undefined || value === '') return null;
    const endChapterIndex = Number(value);
    const chapterCount = Number(this.getChapterCount(this.bookId));
    if (!Number.isInteger(endChapterIndex) || endChapterIndex < startChapterIndex) return null;
    return Number.isInteger(chapterCount) && chapterCount > 0
      ? Math.min(endChapterIndex, chapterCount - 1)
      : endChapterIndex;
  }

  async _waitForPlaybackRunway({
    encodedBookId,
    chapterIndex,
    tierQuery,
    startOffsetSeconds,
    endChapterIndex,
    generation
  }) {
    const controller = new AbortController();
    this._runwayController = controller;
    const query = tierQuery || '';
    const runwayUrl = action => {
      const separator = query ? '&' : '?';
      const endChapter = Number.isInteger(endChapterIndex)
        ? `&endChapter=${endChapterIndex}`
        : '';
      return `/api/chunks/${encodedBookId}/${chapterIndex}/${action}${query}${separator}purpose=playback-runway${endChapter}`;
    };
    const cancelled = () => controller.signal.aborted || generation !== this._generation;
    const cancellationError = () => new LifecycleCancelledError('Chapter runway preparation cancelled');
    const readStatus = async (url, options = {}) => {
      if (cancelled()) throw cancellationError();
      let response;
      try {
        response = await this.fetch(url, { cache: 'no-store', signal: controller.signal, ...options });
      } catch (error) {
        if (cancelled() || error?.name === 'AbortError') throw cancellationError();
        throw error;
      }
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const error = new Error(detail.error || `Playback runway preparation failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    };

    try {
      let status = await readStatus(runwayUrl('prepare-chapter-audio'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purpose: 'playback-runway',
          playbackRate: this.playbackRate,
          offsetSeconds: startOffsetSeconds,
          endChapterIndex
        })
      });
      while (!status?.ready) {
        if (status?.status === 'error') {
          throw new Error('Narration generation failed while preparing playback runway');
        }
        this.onPreparing?.({
          targetChunk: 0,
          targetStatus: 'generating',
          readyChunks: Math.max(0, Number(status?.readyChunks) || 0),
          totalChunks: Math.max(0, Number(status?.totalChunks) || 0),
          purpose: 'playback-runway'
        });
        await this._waitForRunwayPoll(controller.signal, cancellationError);
        status = await readStatus(runwayUrl('chapter-audio-status'));
      }
      this.onPreparing?.({
        targetChunk: 0,
        targetStatus: 'ready',
        readyChunks: Math.max(0, Number(status?.readyChunks) || 0),
        totalChunks: Math.max(0, Number(status?.totalChunks) || 0),
        purpose: 'playback-runway'
      });
      return status;
    } finally {
      if (this._runwayController === controller) this._runwayController = null;
    }
  }

  _waitForRunwayPoll(signal, cancellationError) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        if (timer !== null) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(cancellationError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) return onAbort();
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.runwayPollIntervalMs);
    });
  }

  _cancelRunwayPreparation() {
    this._runwayController?.abort();
    this._runwayController = null;
  }

  _continuousCandidates(
    encodedBookId,
    chapterIndex,
    tierQuery,
    startOffset,
    endChapterIndex = this.endChapterIndex
  ) {
    const candidateFor = transport => {
      const sessionId = this._sessionIdForAttempt(JSON.stringify([
        transport,
        this.bookId,
        chapterIndex,
        tierQuery,
        endChapterIndex ?? 'book',
        startOffset || 0
      ]));
      const parameters = new URLSearchParams(tierQuery.replace(/^\?/, ''));
      parameters.set('session', sessionId);
      if (startOffset > 0) parameters.set('offsetSeconds', String(startOffset));
      if (Number.isInteger(endChapterIndex)) {
        parameters.set('endChapter', String(endChapterIndex));
      }
      if (transport === 'hls') parameters.set('owner', this.playbackOwnerId);
      const route = transport === 'hls'
        ? `/api/audio-hls/${encodedBookId}/${chapterIndex}/index.m3u8`
        : `/api/audio-continuous/${encodedBookId}/${chapterIndex}`;
      return {
        url: `${route}?${parameters.toString()}`,
        continuous: true,
        transport,
        sessionId,
        startOffset,
        endChapterIndex
      };
    };
    // Native HLS is the lock-screen transport on iOS. If it fails, fall back
    // directly to the finite chapter resource instead of probing a second
    // open-ended transport that iOS cannot reliably keep alive in background.
    if (this.isIOSLike()) {
      return this._supportsNativeHls()
        ? [candidateFor('hls')]
        : [];
    }
    return [candidateFor('progressive')];
  }

  _startTimelinePolling() {
    if (!this.fetch || !this.playbackSessionId || !this._eventScope) return;
    const sessionId = this.playbackSessionId;
    const refresh = async () => {
      if (sessionId !== this.playbackSessionId) return;
      try {
        const response = await this.fetch(`/api/audio-timeline/${encodeURIComponent(sessionId)}`, {
          cache: 'no-store'
        });
        if (!response.ok) return;
        const timeline = await response.json();
        if (sessionId !== this.playbackSessionId || !Array.isArray(timeline.durations)) return;
        const mappedStartOffset = Number(timeline.startOffsetSeconds);
        if (Number.isFinite(mappedStartOffset) && mappedStartOffset >= 0) {
          this.streamStartOffset = mappedStartOffset;
        }
        timeline.durations.forEach((duration, offset) => {
          const value = Number(duration);
          if (Number.isFinite(value) && value > 0) {
            this._timelineDurations.set(Number(timeline.startChapterIndex) + offset, value);
          }
        });
        this._syncContinuousChapter();
      } catch {
        // Playback remains valid when diagnostics/timeline polling is offline.
      }
    };
    void refresh();
    // The timeline is what maps stream time onto chapters, so it cannot simply
    // stop while the screen is locked — a chapter boundary crossed in the
    // background still has to land. It can go a lot slower, though. At the
    // foreground rate this single poll was a request every two seconds for the
    // entire length of a book, for a payload that changes only as narration is
    // generated.
    let ticks = 0;
    this._eventScope.interval(
      () => {
        ticks += 1;
        const hidden = globalThis.document?.hidden;
        if (hidden && ticks % TIMELINE_HIDDEN_POLL_RATIO !== 0) return;
        void refresh();
      },
      TIMELINE_POLL_INTERVAL_MS,
      this.clock
    );
  }

  _estimatedDuration(chapterIndex) {
    const measured = Number(this._timelineDurations.get(chapterIndex));
    if (Number.isFinite(measured) && measured > 0) return measured;
    const duration = Number(this.getEstimatedDuration(this.bookId, chapterIndex));
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  _chapterCount() {
    const count = Number(this.getChapterCount(this.bookId));
    const fullCount = Number.isInteger(count) && count > 0
      ? count
      : Math.max(1, (Number(this.chapterIndex) || 0) + 1);
    return Number.isInteger(this.endChapterIndex)
      ? Math.min(fullCount, this.endChapterIndex + 1)
      : fullCount;
  }

  _streamOffsetForChapter(chapterIndex) {
    if (!this.isContinuous || !Number.isInteger(this.startChapterIndex)) return 0;
    let offset = 0;
    for (let index = this.startChapterIndex; index < chapterIndex; index++) {
      const duration = this._estimatedDuration(index);
      offset += index === this.startChapterIndex
        ? Math.max(0, duration - this.streamStartOffset)
        : duration;
    }
    return offset;
  }

  _chapterAtStreamTime(streamTime) {
    if (!this.isContinuous || !Number.isInteger(this.startChapterIndex)) {
      return { chapterIndex: this.chapterIndex, chapterTime: Math.max(0, streamTime) };
    }
    const count = this._chapterCount();
    let offset = 0;
    for (let index = this.startChapterIndex; index < count; index++) {
      const chapterStartOffset = index === this.startChapterIndex
        ? this.streamStartOffset
        : 0;
      const duration = Math.max(0, this._estimatedDuration(index) - chapterStartOffset);
      const isLast = index === count - 1;
      if (isLast || (duration > 0 && streamTime < offset + duration)) {
        return {
          chapterIndex: index,
          chapterTime: Math.max(0, streamTime - offset + chapterStartOffset)
        };
      }
      if (duration > 0) offset += duration;
    }
    return {
      chapterIndex: count - 1,
      chapterTime: Math.max(0, streamTime - offset)
    };
  }

  _syncContinuousChapter(streamTime = Number(this.audio.currentTime) || 0) {
    if (!this.isContinuous) return this._chapterAtStreamTime(streamTime);
    const located = this._chapterAtStreamTime(streamTime);
    if (located.chapterIndex !== this.chapterIndex) {
      const previousChapterIndex = this.chapterIndex;
      this.chapterIndex = located.chapterIndex;
      this.onChapterTransition?.({
        previousChapterIndex,
        chapterIndex: located.chapterIndex,
        chapterTime: located.chapterTime,
        streamTime
      });
      this._emitDiagnostic('chapter-transition', {
        previousChapterIndex,
        chapterIndex: located.chapterIndex
      });
    }
    return located;
  }

  _bufferRunway() {
    try {
      const ranges = this.audio.buffered;
      const currentTime = Number(this.audio.currentTime) || 0;
      for (let index = 0; index < ranges.length; index++) {
        if (currentTime <= ranges.end(index)) {
          return Math.max(0, ranges.end(index) - currentTime);
        }
      }
    } catch {}
    return 0;
  }

  _emitDiagnostic(type, detail = {}) {
    this.onDiagnosticEvent?.({
      type,
      chapterIndex: this.chapterIndex,
      streamTime: Number(this.audio.currentTime) || 0,
      chapterTime: this.getCurrentTime(),
      readyState: Number(this.audio.readyState) || 0,
      networkState: Number(this.audio.networkState) || 0,
      paused: Boolean(this.audio.paused),
      ended: Boolean(this.audio.ended),
      bufferRunway: this._bufferRunway(),
      ...detail
    });
  }

  _handleMediaState(event) {
    this._emitDiagnostic(event?.type || 'media-state');
  }

  /** End of the last buffered range, or 0 when nothing is buffered. */
  _bufferedEnd() {
    const buffered = this.audio.buffered;
    const length = Number(buffered?.length) || 0;
    if (length <= 0) return 0;
    try {
      return Number(buffered.end(length - 1)) || 0;
    } catch {
      return 0;
    }
  }

  _startStallWatchdog() {
    this._stopStallWatchdog();
    if (!this._eventScope || this.stallTimeoutMs <= 0) return;
    this._stallWatchdog = this._eventScope.interval(
      () => this._checkForStall(),
      this.stallProbeIntervalMs,
      this.clock
    );
  }

  _stopStallWatchdog() {
    this._stallWatchdog?.();
    this._stallWatchdog = null;
    this._stallMark = null;
  }

  /**
   * One liveness sample. Reports a recoverable stall only once both the
   * playhead and the buffer have been frozen for the whole timeout, so a
   * paused listener, a seek, or a slow-but-alive transport never trips it.
   */
  _checkForStall() {
    if (this._isLoading || !this._isPlaying || this.audio.paused || this.audio.ended) {
      this._stallMark = null;
      return;
    }
    const currentTime = Number(this.audio.currentTime) || 0;
    const bufferedEnd = this._bufferedEnd();
    const mark = this._stallMark;
    const advanced = !mark
      || currentTime - mark.currentTime > PROGRESS_EPSILON_SECONDS
      || bufferedEnd - mark.bufferedEnd > PROGRESS_EPSILON_SECONDS;
    if (advanced) {
      this._stallMark = { currentTime, bufferedEnd, since: this.now() };
      return;
    }
    const stalledForMs = this.now() - mark.since;
    if (stalledForMs < this.stallTimeoutMs) return;

    // Stop probing before reporting: recovery reloads the chapter, and a second
    // report from the same dead stream would race that attempt.
    this._stopStallWatchdog();
    this._emitDiagnostic('stalled-timeout', { stalledForMs, currentTime, bufferedEnd });
    const error = new Error('Audio stopped advancing mid-playback');
    error.code = 'MEDIA_STALLED';
    error.recoverable = true;
    error.chapterIndex = this.chapterIndex;
    error.chapterTime = this.getCurrentTime();
    this.onError?.(error);
  }

  _handleTimeUpdate() {
    this._syncContinuousChapter();
    this._maybePrewarmNextChapter();
    const now = Date.now();
    if (now - this._lastDiagnosticTimeUpdateAt >= 5000) {
      this._lastDiagnosticTimeUpdateAt = now;
      this._emitDiagnostic('timeupdate');
    }
    if (!this.onTimeUpdate) return;
    const currentTime = this.getCurrentTime();
    const totalTime = this.getTotalTime();
    this.onTimeUpdate({
      chunk: 0,
      chunkIndex: 0,
      chunkTime: currentTime,
      chunkDuration: totalTime,
      currentTime,
      totalTime,
      totalEstimatedTime: currentTime,
      progressPercent: this.getProgressPercent(),
      totalChunks: 1,
      isPlaying: this.isPlaying,
      backend: this.backend,
      source: this.activeSource
    });
  }

  /** The finite, per-chapter resource for a chapter, in this engine's mode. */
  _standardChapterUrl(bookId, chapterIndex) {
    const encodedBookId = encodeURIComponent(bookId);
    if (this.preferStandardAudio && this.resolveOfflineAudioUrl) {
      return this.resolveOfflineAudioUrl(bookId, chapterIndex);
    }
    return this.isIOSLike() && !this.preferStandardAudio
      ? `/api/audio-ios/${encodedBookId}/${chapterIndex}`
      : `/api/audio/${encodedBookId}/${chapterIndex}`;
  }

  /**
   * The source a pre-warm should fetch when the app offers nothing local.
   *
   * Only for a streamed session that is already on the finite chapter fallback:
   * that is the one streamed shape which has to replace the media source at a
   * chapter boundary, and it downloads the whole chapter file either way — 45s
   * earlier is the only difference. A downloaded book stays local-only, because
   * quietly streaming a chapter the listener believes is on the device is a
   * decision that belongs to loadChapter, with its own messaging.
   */
  _prewarmFallbackUrl(chapterIndex) {
    if (this.preferStandardAudio || this.isContinuous) return null;
    if (globalThis.navigator && globalThis.navigator.onLine === false) return null;
    const url = this._standardChapterUrl(this.bookId, chapterIndex);
    return this.servedTier ? `${url}?tier=${encodeURIComponent(this.servedTier)}` : url;
  }

  /** Whether a sleep timer means playback must stop at the current chapter. */
  _stopsAtCurrentChapter() {
    const limit = Number.isInteger(this.endChapterIndex)
      ? this.endChapterIndex
      : this.getContinuousEndChapter(this.bookId, this.chapterIndex);
    return Number.isInteger(limit) && limit <= this.chapterIndex;
  }

  _releasePrewarm() {
    this._abortPrewarm();
    if (this._prewarm?.objectUrl) this._revokeObjectUrl(this._prewarm.objectUrl);
    this._prewarm = null;
    this._prewarmDeclined = null;
  }

  /**
   * Stop a pre-warm that is still downloading.
   *
   * A streamed chapter can be tens of megabytes; once the boundary has been
   * reached without it, the ordinary load is the one that needs the bandwidth.
   */
  _abortPrewarm() {
    this._prewarmController?.abort();
    this._prewarmController = null;
    this._prewarmInFlight = null;
  }

  _revokeObjectUrl(objectUrl) {
    if (!objectUrl) return;
    try { globalThis.URL?.revokeObjectURL?.(objectUrl); } catch {}
    if (this._activeObjectUrl === objectUrl) this._activeObjectUrl = null;
  }

  /**
   * Fetch the next chapter while this one still has audio left to play.
   *
   * Deliberately driven from `timeupdate` rather than a timer: a backgrounded
   * page keeps receiving media events while audio is playing, but its timers
   * are throttled to the point where a boundary can pass unnoticed.
   */
  _maybePrewarmNextChapter() {
    if (this.isContinuous || this._isLoading || !this._isPlaying) return;
    if (!this.resolveNextChapterUrl || !this.fetch) return;
    if (typeof globalThis.URL?.createObjectURL !== 'function') return;
    if (this._stopsAtCurrentChapter()) return;
    const nextChapterIndex = this.chapterIndex + 1;
    if (nextChapterIndex >= this._chapterCount()) return;
    if (this._prewarm?.chapterIndex === nextChapterIndex) return;
    if (this._prewarmDeclined === nextChapterIndex) return;
    if (this._prewarmInFlight !== null) return;
    const duration = Number(this.audio.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const remaining = duration - (Number(this.audio.currentTime) || 0);
    if (remaining > this.prewarmLeadSeconds) return;
    void this._prewarmChapter(nextChapterIndex);
  }

  async _prewarmChapter(chapterIndex) {
    const bookId = this.bookId;
    const generation = this._generation;
    const superseded = () => generation !== this._generation || bookId !== this.bookId;
    const controller = typeof globalThis.AbortController === 'function'
      ? new globalThis.AbortController()
      : null;
    this._prewarmController = controller;
    this._prewarmInFlight = chapterIndex;
    try {
      const local = await this.resolveNextChapterUrl?.(bookId, chapterIndex);
      if (superseded()) return;
      const url = local || this._prewarmFallbackUrl(chapterIndex);
      if (!url) {
        this._prewarmDeclined = chapterIndex;
        return;
      }
      const response = await this.fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!response?.ok) {
        throw Object.assign(
          new Error(`Next chapter could not be pre-warmed (${response?.status || 0})`),
          { status: response?.status || 0 }
        );
      }
      const blob = await response.blob();
      if (superseded() || controller?.signal.aborted) return;
      this._releasePrewarm();
      this._prewarm = {
        chapterIndex,
        objectUrl: globalThis.URL.createObjectURL(blob)
      };
      this._emitDiagnostic('chapter-prewarmed', {
        chapterIndex,
        sourceKind: 'chapter'
      });
    } catch (error) {
      // A chapter that cannot be pre-warmed still advances the ordinary way.
      // One attempt per chapter: a failure that repeats every timeupdate would
      // spend the rest of the chapter retrying a fetch that is not going to
      // work, against the bandwidth the audio itself needs.
      if (!superseded() && !controller?.signal.aborted) this._prewarmDeclined = chapterIndex;
      this._emitDiagnostic('chapter-prewarm-failed', {
        chapterIndex,
        reason: error?.code || error?.name || 'prewarm-failed'
      });
    } finally {
      if (this._prewarmController === controller) this._prewarmController = null;
      if (this._prewarmInFlight === chapterIndex) this._prewarmInFlight = null;
    }
  }

  /**
   * Continue into the pre-warmed next chapter from inside the `ended` event.
   *
   * Nothing here awaits: the source is already in memory, so the swap and the
   * play() call both happen in the same task as the media event. That is what
   * keeps a locked phone playing — it needs no network, no service worker, and
   * no fresh activation.
   *
   * @returns {boolean} true when the next chapter took over the element.
   */
  _advanceToPrewarmedChapter() {
    if (this.isContinuous || !this._isPlaying) return false;
    const nextChapterIndex = this.chapterIndex + 1;
    const prewarmed = this._prewarm;
    if (!prewarmed || prewarmed.chapterIndex !== nextChapterIndex) return false;
    if (nextChapterIndex >= this._chapterCount()) return false;
    if (this._stopsAtCurrentChapter()) return false;

    const previousChapterIndex = this.chapterIndex;
    const previousObjectUrl = this._activeObjectUrl;
    this._prewarm = null;
    this.chapterIndex = nextChapterIndex;
    this.startChapterIndex = nextChapterIndex;
    this.streamStartOffset = 0;
    this.requestedStartOffset = 0;
    this.playbackSessionId = null;
    this.backend = 'single-file';
    this.activeSource = prewarmed.objectUrl;
    this._activeObjectUrl = prewarmed.objectUrl;
    // The new resource starts at zero with an empty buffer; a liveness sample
    // taken against the finished chapter would read that as a frozen stream.
    this._stallMark = null;
    this._playReason = 'chapter-advance';
    // Belt and braces for mobile browsers that reject a programmatic play() on
    // a backgrounded page: the element is already authorized to play, so let it
    // start on its own the moment the blob is decodable. Cleared again as soon
    // as playback starts, so an ordinary load() never autostarts.
    this.audio.autoplay = true;
    this.audio.src = prewarmed.objectUrl;
    this.audio.load();
    const started = Promise.resolve(this.audio.play());
    started.catch(error => {
      // Whether the element starts on its own is now out of this call's hands;
      // leaving the attribute set would autostart the next ordinary load.
      this.audio.autoplay = false;
      this._emitDiagnostic('chapter-advance-failed', {
        chapterIndex: nextChapterIndex,
        reason: error?.name || 'play-rejected'
      });
      this._isPlaying = false;
      this.onPlaybackChange?.(false, { reason: 'chapter-advance', error });
    });
    if (previousObjectUrl !== prewarmed.objectUrl) this._revokeObjectUrl(previousObjectUrl);
    this._emitDiagnostic('chapter-advance', {
      previousChapterIndex,
      chapterIndex: nextChapterIndex
    });
    this.onChapterAdvance?.({
      previousChapterIndex,
      chapterIndex: nextChapterIndex,
      chapterTime: 0
    });
    return true;
  }

  _handleEnded() {
    // Gapless first: the swap has to happen before anything reports a pause,
    // or the media session state flickers on the lock screen.
    if (this._advanceToPrewarmedChapter()) return;
    // The boundary arrived first. Whatever is still downloading has lost its
    // purpose and would only compete with the load that has to happen now.
    this._abortPrewarm();
    this._isPlaying = false;
    this._stopStallWatchdog();
    if (this.isContinuous) {
      this._syncContinuousChapter(Number(this.audio.currentTime) || 0);
      if (Number.isInteger(this.endChapterIndex)) {
        this._emitDiagnostic('continuous-limit-ended', {
          reason: 'end-chapter-limit',
          endChapterIndex: this.endChapterIndex
        });
        this.onChapterEnd?.({
          reason: 'continuous-limit',
          endChapterIndex: this.endChapterIndex
        });
        return;
      }
      const lastChapterIndex = this._chapterCount() - 1;
      if (this.chapterIndex < lastChapterIndex) {
        const error = new Error('Continuous playback ended before the end of the book');
        error.name = 'UnexpectedEndError';
        error.code = 'CONTINUOUS_STREAM_EOF';
        error.recoverable = true;
        error.chapterIndex = this.chapterIndex;
        error.chapterTime = this.getCurrentTime();
        this._emitDiagnostic('unexpected-ended', {
          reason: 'premature-eof'
        });
        this.onPlaybackChange?.(false, { reason: 'unexpected-ended', error });
        this.onError?.(error);
        return;
      }
    }
    this._emitDiagnostic('ended');
    this.onChapterEnd?.();
  }

  _handleError() {
    this._emitDiagnostic('error', {
      errorCode: Number(this.audio.error?.code) || 0
    });
    if (this._isLoading) return;
    this.onError?.(this._audioError());
  }

  _handleNativePlay(event) {
    this.audio.autoplay = false;
    const wasPlaying = this._isPlaying;
    const reason = this._playReason || 'external';
    this._playReason = null;
    this._pauseReason = null;
    this._isPlaying = true;
    // Watch for silent death only while audio is actually meant to be running.
    if (!this._stallWatchdog) this._startStallWatchdog();
    this._emitDiagnostic(event?.type || 'playing', { reason });
    if (wasPlaying && reason === 'external') return;
    this.onPlaybackChange?.(true, { reason });
  }

  _handleNativePause() {
    if (this.audio.ended) return;
    this._isPlaying = false;
    this._stopStallWatchdog();
    const reason = this._pauseReason || 'external';
    this._pauseReason = null;
    this._emitDiagnostic('pause', { reason });
    this.onPlaybackChange?.(false, { reason });
  }

  async play() {
    this._pauseReason = null;
    this._playReason = 'app';
    this._isPlaying = true;
    const startTime = Number(this.audio.currentTime) || 0;
    const wait = waitForMediaEvents(this.audio, {
      resolveEvents: ['playing'],
      rejectEvents: ['error'],
      timeoutMs: this.playTimeoutMs,
      timeoutError: () => Object.assign(
        new Error(`Audio did not start within ${Math.ceil(this.playTimeoutMs / 1000)} seconds`),
        { code: 'MEDIA_PLAY_TIMEOUT' }
      ),
      eventError: () => this._audioError(),
      cancelledError: () => new LifecycleCancelledError('Playback start cancelled')
    });
    this._playWait = wait;
    let progressWait = null;
    // Observe the event wait immediately. audio.play() can reject before the
    // next await, and teardown must not turn cancellation of this sibling
    // promise into an unhandled rejection.
    wait.promise.catch(() => {});
    try {
      const nativePlay = Promise.resolve(this.audio.play());
      nativePlay.catch(() => {});
      await Promise.race([nativePlay, wait.promise]);
      await wait.promise;
      progressWait = this._waitForPlaybackProgress(startTime);
      this._playProgressWait = progressWait;
      progressWait.promise.catch(() => {});
      await progressWait.promise;
    } catch (error) {
      this._isPlaying = false;
      this.onPlaybackChange?.(false, { reason: 'app', error });
      throw error;
    } finally {
      wait.cancel();
      if (this._playWait === wait) this._playWait = null;
      progressWait?.cancel();
      if (this._playProgressWait === progressWait) this._playProgressWait = null;
      this._playReason = null;
    }
  }

  pause(reason = 'app') {
    this._isPlaying = false;
    this._pauseReason = reason;
    this.audio.pause();
  }
  get isPlaying() { return this._isPlaying && !this.audio.paused; }
  _streamTimeForChapterTime(seconds) {
    const chapterTime = Math.max(0, Math.min(Number(seconds) || 0, this.getTotalTime() || Number(seconds) || 0));
    const streamTime = this._streamOffsetForChapter(this.chapterIndex)
      + chapterTime
      - (this.chapterIndex === this.startChapterIndex ? this.streamStartOffset : 0);
    return { chapterTime, streamTime };
  }

  /**
   * Relocate without awaiting anything, or report that it is not possible.
   *
   * Callers running inside a user-activation window (a tap, a lock-screen
   * control) must not await before audio.play(), so they use this and degrade
   * when it returns false rather than reloading the source.
   *
   * @returns {boolean} true when the position was applied.
   */
  trySeekSync(seconds) {
    const { streamTime } = this._streamTimeForChapterTime(seconds);
    if (this.isContinuous && !this._canSeekTo(streamTime)) return false;
    this.audio.currentTime = Math.max(0, streamTime);
    this._handleTimeUpdate();
    return true;
  }

  /**
   * Did this continuous source already open at exactly this chapter position?
   *
   * If so the caller must skip its follow-up seek. seek() clamps its target to
   * the *estimated* chapter duration, and when that estimate is below the resume
   * offset the clamp drags the target backwards, out of the buffered range, and
   * the stream relocates — spending a second server session to reach a position
   * the source was already sitting at.
   *
   * Only ever true for a continuous transport; a finite chapter file is freely
   * seekable and its seek is both cheap and necessary.
   */
  openedAtOffset(chapterIndex, seconds) {
    if (!this.isContinuous) return false;
    if (this.chapterIndex !== chapterIndex || this.startChapterIndex !== chapterIndex) return false;
    const target = Number(seconds);
    if (!Number.isFinite(target)) return false;
    return Math.abs(this.requestedStartOffset - target) < 0.01;
  }

  /**
   * @param {number} seconds Target position within the current chapter.
   * @param {{allowReload?: boolean}} [options] `allowReload: false` forbids
   *   replacing the media source, which would both close an iOS activation
   *   window and mint a new server session. Used by Smart Rewind.
   * @returns {Promise<boolean>} whether the position was applied.
   */
  async seek(seconds, options = {}) {
    const allowReload = options.allowReload !== false;
    const { chapterTime, streamTime } = this._streamTimeForChapterTime(seconds);
    if (this.isContinuous && !this._canSeekTo(streamTime)) {
      if (!allowReload) return false;
      await this._reloadContinuousAtOffset(chapterTime);
      return true;
    }
    this.audio.currentTime = Math.max(0, streamTime);
    this._handleTimeUpdate();
    return true;
  }
  async seekToChunk(_chunkIndex, chunkTime = 0) { await this.seek(chunkTime); }
  async skip(seconds) {
    if (this.isContinuous) {
      await this.seek(this.getCurrentTime() + Number(seconds || 0));
      return;
    }
    await this.seek(this.getCurrentTime() + seconds);
  }

  async setContinuousEndChapter(endChapterIndex = null) {
    const normalized = endChapterIndex === null || endChapterIndex === undefined
      ? null
      : this._normalizeEndChapter(endChapterIndex, this.chapterIndex);
    if (normalized === this.endChapterIndex) return;
    this.endChapterIndex = normalized;
    if (!this.isContinuous || !this.activeSource || this.audio.ended) return;
    await this._reloadContinuousAtOffset(this.getCurrentTime());
  }

  _canSeekTo(streamTime) {
    if (!Number.isFinite(streamTime) || streamTime < 0) return false;
    const tolerance = 0.05;
    try {
      for (let index = 0; index < this.audio.buffered.length; index++) {
        if (
          streamTime >= this.audio.buffered.start(index) - tolerance
          && streamTime <= this.audio.buffered.end(index) + tolerance
        ) {
          return true;
        }
      }
    } catch {}
    return Math.abs(streamTime - Number(this.audio.currentTime)) <= tolerance;
  }

  async _reloadContinuousAtOffset(chapterTime) {
    const wasPlaying = this.isPlaying || !this.audio.paused;
    const generation = ++this._generation;
    const encodedBookId = encodeURIComponent(this.bookId);
    const tierQuery = this.servedTier
      ? `?tier=${encodeURIComponent(this.servedTier)}`
      : '';
    const candidate = this._continuousCandidates(
      encodedBookId,
      this.chapterIndex,
      tierQuery,
      chapterTime,
      this.endChapterIndex
    )[0];
    this._detach();
    this.audio.pause();
    this.startChapterIndex = this.chapterIndex;
    this.streamStartOffset = chapterTime;
    this.requestedStartOffset = chapterTime;
    this.playbackSessionId = candidate.sessionId;
    this._timelineDurations.clear();
    this._attach();
    const wait = waitForMediaEvents(this.audio, {
      resolveEvents: ['loadedmetadata', 'canplay'],
      rejectEvents: ['error'],
      timeoutMs: this.loadTimeoutMs,
      timeoutError: () => Object.assign(new Error('Seek transport timed out'), {
        code: 'MEDIA_LOAD_TIMEOUT'
      }),
      eventError: () => this._audioError(),
      cancelledError: () => new LifecycleCancelledError('Seek cancelled')
    });
    this._loadWait = wait;
    this._isLoading = true;
    this.audio.src = candidate.url;
    this.activeSource = candidate.url;
    this._emitDiagnostic('source-reload', {
      sourceKind: candidate.transport,
      reason: 'nonseekable-offset',
      chapterTime
    });
    this.audio.load();
    const nativePlay = wasPlaying ? Promise.resolve(this.audio.play()) : null;
    nativePlay?.catch(() => {});
    try {
      await wait.promise;
      if (nativePlay) await nativePlay;
      if (generation !== this._generation) return;
      this._startTimelinePolling();
      this._handleTimeUpdate();
    } finally {
      if (this._loadWait === wait) this._loadWait = null;
      this._isLoading = false;
    }
  }
  async seekToPercent(percent) { await this.seek((Math.max(0, Math.min(100, percent)) / 100) * this.getTotalTime()); }
  setSpeed(rate) { this.playbackRate = rate; this.audio.playbackRate = rate; }
  setVolume(volume) { this._volume = Math.max(0, Math.min(1, volume)); this.audio.volume = this._volume; }
  getVolume() { return this._volume; }
  getBufferRunway() { return this._bufferRunway(); }
  getCurrentTime() {
    const streamTime = Number(this.audio.currentTime) || 0;
    return this._chapterAtStreamTime(streamTime).chapterTime;
  }
  getTotalTime() {
    if (this.isContinuous) return this._estimatedDuration(this.chapterIndex);
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return this.audio.duration;
    return this._estimatedDuration(this.chapterIndex);
  }
  getProgressPercent() {
    const total = this.getTotalTime();
    return total > 0 ? Math.min(100, (this.getCurrentTime() / total) * 100) : 0;
  }
  getPosition() {
    const currentTime = this.getCurrentTime();
    const totalTime = this.getTotalTime();
    return {
      chunk: 0,
      chunkIndex: 0,
      chunkTime: currentTime,
      chunkDuration: totalTime,
      currentTime,
      totalTime,
      totalEstimatedTime: currentTime,
      progressPercent: this.getProgressPercent(),
      totalChunks: 1,
      isPlaying: this.isPlaying,
      backend: this.backend,
      source: this.activeSource,
      servedTier: this.servedTier,
      chapterIndex: this.chapterIndex,
      streamTime: Number(this.audio.currentTime) || 0,
      continuous: this.isContinuous
    };
  }
  cancelPendingLoad() {
    this._generation++;
    this._isLoading = false;
    this._cancelRunwayPreparation();
    this.pause();
    this._detach();
  }
  dispose() {
    this.cancelPendingLoad();
    this.audio.removeAttribute('src');
    this.audio.load();
    this._releasePrewarm();
    this._revokeObjectUrl(this._activeObjectUrl);
  }
  destroy() { this.dispose(); }
}
