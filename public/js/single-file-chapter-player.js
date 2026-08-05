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
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis) || null;
    this.preferStandardAudio = Boolean(options.preferStandardAudio);
    this.loadTimeoutMs = Number(options.loadTimeoutMs) > 0 ? Number(options.loadTimeoutMs) : LOAD_TIMEOUT_MS;
    this.playTimeoutMs = Number(options.playTimeoutMs) > 0 ? Number(options.playTimeoutMs) : 10000;
    this.playProgressTimeoutMs = Number(options.playProgressTimeoutMs) > 0
      ? Number(options.playProgressTimeoutMs)
      : 3000;
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
    this._isLoading = false;
    this._eventScope = null;
    this._playWait = null;
    this._playProgressWait = null;
    this._pauseReason = null;
    this._playReason = null;
    this._lastDiagnosticTimeUpdateAt = 0;
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
    this._attach();
    this.onWaiting?.('Loading audio…');
    const encodedBookId = encodeURIComponent(bookId);
    const standardUrl = this.preferStandardAudio && this.resolveOfflineAudioUrl
      ? this.resolveOfflineAudioUrl(bookId, chapterIndex)
      : this.isIOSLike() && !this.preferStandardAudio
        ? `/api/audio-ios/${encodedBookId}/${chapterIndex}`
        : `/api/audio/${encodedBookId}/${chapterIndex}`;
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
    this._isLoading = true;
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
  }

  _detach() {
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
    this._eventScope.interval(() => { void refresh(); }, 2000);
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

  _handleTimeUpdate() {
    this._syncContinuousChapter();
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

  _handleEnded() {
    this._isPlaying = false;
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
    const wasPlaying = this._isPlaying;
    const reason = this._playReason || 'external';
    this._playReason = null;
    this._pauseReason = null;
    this._isPlaying = true;
    this._emitDiagnostic(event?.type || 'playing', { reason });
    if (wasPlaying && reason === 'external') return;
    this.onPlaybackChange?.(true, { reason });
  }

  _handleNativePause() {
    if (this.audio.ended) return;
    this._isPlaying = false;
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
    this.pause();
    this._detach();
  }
  dispose() {
    this.cancelPendingLoad();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
  destroy() { this.dispose(); }
}
