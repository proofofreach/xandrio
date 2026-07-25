/**
 * Native-audio chapter engine used for reliable iOS and downloaded playback.
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
    this.isIOSLike = options.isIOSLike || (() => false);
    this.getEstimatedDuration = options.getEstimatedDuration || (() => 0);
    this.resolveServedTier = options.resolveServedTier || null;
    this.preferStandardAudio = Boolean(options.preferStandardAudio);
    this.loadTimeoutMs = Number(options.loadTimeoutMs) > 0 ? Number(options.loadTimeoutMs) : LOAD_TIMEOUT_MS;
    this.backend = 'single-file';
    this.activeSource = null;
    this.servedTier = null;
    this.supportsNativeMediaSession = true;
    this.bookId = null;
    this.chapterIndex = null;
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
    this._boundTimeUpdate = this._handleTimeUpdate.bind(this);
    this._boundEnded = this._handleEnded.bind(this);
    this._boundError = this._handleError.bind(this);
    this._boundNativePlay = this._handleNativePlay.bind(this);
    this._boundNativePause = this._handleNativePause.bind(this);
  }

  async loadChapter(bookId, chapterIndex) {
    const gen = ++this._generation;
    this.pause();
    this.bookId = bookId;
    this.chapterIndex = chapterIndex;
    this.currentChunk = 0;
    this.totalChunks = 1;
    this._detach();
    this.audio.preload = 'auto';
    this.audio.volume = this._volume;
    this.audio.playbackRate = this.playbackRate;
    this._attach();
    this.onWaiting?.('Loading audio…');
    const encodedBookId = encodeURIComponent(bookId);
    const standardUrl = this.isIOSLike() && !this.preferStandardAudio
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
    const sourceCandidates = this.preferStandardAudio
      ? [standardUrl]
      : [
          `/api/audio-stream/${encodedBookId}/${chapterIndex}${tierQuery}`,
          `${standardUrl}${tierQuery}`
        ];
    let lastError = null;
    this._isLoading = true;
    try {
      for (const source of sourceCandidates) {
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
        this.audio.src = source;
        try {
          this.audio.load();
          await wait.promise;
          this.activeSource = source;
          this.backend = source.startsWith('/api/audio-stream/') ? 'audio-stream' : 'single-file';
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

  _handleTimeUpdate() {
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
    this.onChapterEnd?.();
  }

  _handleError() {
    if (this._isLoading) return;
    this.onError?.(this._audioError());
  }

  _handleNativePlay() {
    const wasPlaying = this._isPlaying;
    const reason = this._playReason || 'external';
    this._playReason = null;
    this._isPlaying = true;
    if (wasPlaying && reason === 'external') return;
    this.onPlaybackChange?.(true, { reason });
  }

  _handleNativePause() {
    if (this.audio.ended) return;
    this._isPlaying = false;
    const reason = this._pauseReason || 'external';
    this._pauseReason = null;
    this.onPlaybackChange?.(false, { reason });
  }

  async play() {
    this._pauseReason = null;
    this._playReason = 'app';
    this._isPlaying = true;
    const wait = waitForMediaEvents(this.audio, {
      resolveEvents: ['playing'],
      rejectEvents: ['error'],
      timeoutMs: 1500,
      resolveOnTimeout: true,
      eventError: () => this._audioError(),
      cancelledError: () => new LifecycleCancelledError('Playback start cancelled')
    });
    this._playWait = wait;
    // Observe the event wait immediately. audio.play() can reject before the
    // next await, and teardown must not turn cancellation of this sibling
    // promise into an unhandled rejection.
    wait.promise.catch(() => {});
    try {
      await this.audio.play();
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
    this.audio.currentTime = Math.max(0, Math.min(Number(seconds) || 0, this.getTotalTime() || Number(seconds) || 0));
    this._handleTimeUpdate();
  }
  async seekToChunk(_chunkIndex, chunkTime = 0) { await this.seek(chunkTime); }
  async skip(seconds) { await this.seek(this.getCurrentTime() + seconds); }
  async seekToPercent(percent) { await this.seek((Math.max(0, Math.min(100, percent)) / 100) * this.getTotalTime()); }
  setSpeed(rate) { this.playbackRate = rate; this.audio.playbackRate = rate; }
  setVolume(volume) { this._volume = Math.max(0, Math.min(1, volume)); this.audio.volume = this._volume; }
  getVolume() { return this._volume; }
  getCurrentTime() { return this.audio.currentTime || 0; }
  getTotalTime() {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return this.audio.duration;
    const estimated = Number(this.getEstimatedDuration(this.bookId, this.chapterIndex));
    return Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
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
      servedTier: this.servedTier
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
