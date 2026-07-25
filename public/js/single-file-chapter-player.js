/**
 * Native-audio engine used for continuous online and downloaded playback.
 * It implements the same playback adapter contract used by ChunkPlayer.
 */

// A media element that neither fires `canplay`/`loadedmetadata` nor `error`
// (backgrounded iOS tab, silently stalled response) would otherwise leave
// loadChapter() pending forever with the loading overlay stuck up.
const LOAD_TIMEOUT_MS = 30000;
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
    this.backend = 'single-file';
    this.activeSource = null;
    this.servedTier = null;
    this.supportsNativeMediaSession = true;
    this.bookId = null;
    this.chapterIndex = null;
    this.startChapterIndex = null;
    this.isContinuous = false;
    this.streamStartOffset = 0;
    this.playbackSessionId = null;
    this.playbackOwnerId = this._newPlaybackSessionId();
    this.endChapterIndex = null;
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

  async loadChapter(bookId, chapterIndex) {
    const gen = ++this._generation;
    this.pause();
    this.bookId = bookId;
    this.chapterIndex = chapterIndex;
    this.startChapterIndex = chapterIndex;
    this.isContinuous = false;
    this.streamStartOffset = 0;
    this.playbackSessionId = null;
    this.endChapterIndex = this._normalizeEndChapter(
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
    if (!this.preferStandardAudio && this.resolveServedTier) {
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
      0
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
      if (gen === this._generation && !error?.cancelled) this.onError?.(error);
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
    this._eventScope?.dispose();
    this._eventScope = null;
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
      const sessionId = this._newPlaybackSessionId();
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
    return this._supportsNativeHls()
      ? [candidateFor('hls')]
      : [candidateFor('progressive')];
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
    // Observe the event wait immediately. audio.play() can reject before the
    // next await, and teardown must not turn cancellation of this sibling
    // promise into an unhandled rejection.
    wait.promise.catch(() => {});
    try {
      const nativePlay = Promise.resolve(this.audio.play());
      nativePlay.catch(() => {});
      await Promise.race([nativePlay, wait.promise]);
      await wait.promise;
    } catch (error) {
      this._isPlaying = false;
      this.onPlaybackChange?.(false, { reason: 'app', error });
      throw error;
    } finally {
      wait.cancel();
      if (this._playWait === wait) this._playWait = null;
      this._playReason = null;
    }
  }

  pause(reason = 'app') {
    this._isPlaying = false;
    this._pauseReason = reason;
    this.audio.pause();
  }
  get isPlaying() { return this._isPlaying && !this.audio.paused; }
  async seek(seconds) {
    const chapterTime = Math.max(0, Math.min(Number(seconds) || 0, this.getTotalTime() || Number(seconds) || 0));
    const streamTime = this._streamOffsetForChapter(this.chapterIndex)
      + chapterTime
      - (this.chapterIndex === this.startChapterIndex ? this.streamStartOffset : 0);
    if (this.isContinuous && !this._canSeekTo(streamTime)) {
      await this._reloadContinuousAtOffset(chapterTime);
      return;
    }
    this.audio.currentTime = Math.max(0, streamTime);
    this._handleTimeUpdate();
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
    try {
      for (let index = 0; index < this.audio.seekable.length; index++) {
        if (streamTime >= this.audio.seekable.start(index) && streamTime <= this.audio.seekable.end(index)) {
          return true;
        }
      }
    } catch {}
    return streamTime === Number(this.audio.currentTime);
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
