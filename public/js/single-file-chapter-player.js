/**
 * Native-audio chapter engine used for reliable iOS and downloaded playback.
 * It implements the same playback adapter contract used by ChunkPlayer.
 */

// A media element that neither fires `canplay`/`loadedmetadata` nor `error`
// (backgrounded iOS tab, silently stalled response) would otherwise leave
// loadChapter() pending forever with the loading overlay stuck up.
const LOAD_TIMEOUT_MS = 30000;

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
    this.preferStandardAudio = Boolean(options.preferStandardAudio);
    this.loadTimeoutMs = Number(options.loadTimeoutMs) > 0 ? Number(options.loadTimeoutMs) : LOAD_TIMEOUT_MS;
    this.backend = 'single-file';
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
    this._loadCleanup = null;
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
    this.audio.src = !this.preferStandardAudio && this.isIOSLike()
      ? `/api/audio-ios/${encodeURIComponent(bookId)}/${chapterIndex}`
      : `/api/audio/${encodeURIComponent(bookId)}/${chapterIndex}`;
    this.audio.volume = this._volume;
    this.audio.playbackRate = this.playbackRate;
    this._attach();
    this.onWaiting?.('Loading audio…');
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(this._audioError()); };
      const timeout = () => {
        cleanup();
        const error = this._audioError();
        this.onError?.(error);
        reject(error);
      };
      const timer = setTimeout(timeout, this.loadTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this._loadCleanup = null;
        this.audio.removeEventListener('loadedmetadata', done);
        this.audio.removeEventListener('canplay', done);
        this.audio.removeEventListener('error', fail);
      };
      // A newer loadChapter() (or dispose()) settles this wait through
      // _detach() so it can never linger on the shared audio element and
      // resolve off the *next* chapter's events. The generation check below
      // turns the superseded resolution into a silent no-op.
      this._loadCleanup = () => { cleanup(); resolve(); };
      this.audio.addEventListener('loadedmetadata', done, { once: true });
      this.audio.addEventListener('canplay', done, { once: true });
      this.audio.addEventListener('error', fail, { once: true });
      this.audio.load();
    });
    if (gen !== this._generation) return;
    this.onReady?.();
    this._handleTimeUpdate();
  }

  _attach() {
    this._detach();
    this.audio.addEventListener('timeupdate', this._boundTimeUpdate);
    this.audio.addEventListener('ended', this._boundEnded);
    this.audio.addEventListener('error', this._boundError);
    this.audio.addEventListener('play', this._boundNativePlay);
    this.audio.addEventListener('playing', this._boundNativePlay);
    this.audio.addEventListener('pause', this._boundNativePause);
  }

  _detach() {
    const settleLoad = this._loadCleanup;
    this._loadCleanup = null;
    settleLoad?.();
    this.audio.removeEventListener('timeupdate', this._boundTimeUpdate);
    this.audio.removeEventListener('ended', this._boundEnded);
    this.audio.removeEventListener('error', this._boundError);
    this.audio.removeEventListener('play', this._boundNativePlay);
    this.audio.removeEventListener('playing', this._boundNativePlay);
    this.audio.removeEventListener('pause', this._boundNativePause);
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
      isPlaying: this._isPlaying
    });
  }

  _handleEnded() {
    this._isPlaying = false;
    this.onChapterEnd?.();
  }

  _handleError() {
    this.onError?.(this._audioError());
  }

  _handleNativePlay() {
    this._isPlaying = true;
    this.onPlaybackChange?.(true);
  }

  _handleNativePause() {
    if (this.audio.ended) return;
    this._isPlaying = false;
    this.onPlaybackChange?.(false);
  }

  async play() {
    this._isPlaying = true;
    try {
      const playing = new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(this._audioError()); };
        const timer = setTimeout(done, 1500);
        const cleanup = () => {
          clearTimeout(timer);
          this.audio.removeEventListener('playing', done);
          this.audio.removeEventListener('error', fail);
        };
        this.audio.addEventListener('playing', done, { once: true });
        this.audio.addEventListener('error', fail, { once: true });
      });
      await this.audio.play();
      await playing;
    } catch (error) {
      this._isPlaying = false;
      throw error;
    }
  }

  pause() { this._isPlaying = false; this.audio.pause(); }
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
  getTotalTime() { return Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }
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
      isPlaying: this._isPlaying
    };
  }
  cancelPendingLoad() {
    this._generation++;
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
