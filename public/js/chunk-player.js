/**
 * ChunkPlayer - single-element chunked audio playback fallback
 * 
 * Plays chapter audio as a sequence of pre-generated audio chunks while
 * preserving the media element that received the user's original play gesture.
 * 
 * Usage:
 *   const player = new ChunkPlayer({
 *     onTimeUpdate: (info) => { ... },
 *     onChunkChange: (chunkIndex) => { ... },
 *     onChapterEnd: () => { ... },
 *     onError: (err) => { ... },
 *     onReady: () => { ... },
 *     onWaiting: (message) => { ... },
 *     onPreparing: (info) => { ... },
 *   });
 *   await player.loadChapter('book123', 0);
 *   player.play();
 */

const { LifecycleCancelledError, waitForMediaEvents } = globalThis.XandrioLifecycle || {};

class ChunkPlayer {
  constructor(options = {}) {
    this.audio = options.audio || new Audio();
    this.backend = 'chunked';
    this.supportsNativeMediaSession = true;

    // Current chapter state
    this.bookId = null;
    this.chapterIndex = null;
    this.currentChunk = 0;
    this.totalChunks = 0;
    this.manifest = null;

    // Duration tracking for cross-chunk seeking
    this.chunkDurations = []; // indexed by chunk number; null if unknown

    // Callbacks
    this.onTimeUpdate = options.onTimeUpdate || null;
    this.onChunkChange = options.onChunkChange || null;
    this.onChapterEnd = options.onChapterEnd || null;
    this.onError = options.onError || null;
    this.onReady = options.onReady || null;
    this.onWaiting = options.onWaiting || null;
    this.onPreparing = options.onPreparing || null;

    // Playback settings
    this.playbackRate = 1.0;
    this._volume = 1.0;
    this._isPlaying = false;
    this._destroyed = false;

    // Bounded retries for transient chunk load/play failures
    this._maxChunkLoadRetries = Number.isInteger(options.maxChunkLoadRetries) ? options.maxChunkLoadRetries : 2;
    this._maxPlayRetries = Number.isInteger(options.maxPlayRetries) ? options.maxPlayRetries : 1;
    this._retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : 300;
    this._chunkLoadTimeoutMs = Number(options.chunkLoadTimeoutMs) > 0 ? Number(options.chunkLoadTimeoutMs) : 30000;

    // Polling handle for manifest checks
    this._pollTimer = null;
    this._cancelPollWait = null;
    this._pendingAudioLoads = new Set();
    this._requestController = null;
    this._timeUpdateTimer = null;
    this._manifestRefreshFailures = 0;

    // Preload state tracking
    this._preloadedChunk = -1; // chunk index prepared by the server
    this._preloadReady = false; // whether the next source is ready to load
    this._preloadToken = 0;
    // Incremented on every loadChapter()/destroy(). Async chains capture it
    // on entry and bail after each await if a newer chapter has taken over,
    // so an in-flight transition can't mutate the new chapter's state.
    this._generation = 0;

    // Bind event handlers so they can be added/removed
    this._onActiveEnded = this._handleActiveEnded.bind(this);
    this._onActiveTimeUpdate = this._handleTimeUpdate.bind(this);
    this._onActiveError = this._handleError.bind(this);

    this._setupAudioElement(this.audio);
  }

  // ---------------------------------------------------------------------------
  // Initialization helpers
  // ---------------------------------------------------------------------------

  _setupAudioElement(audio) {
    audio.preload = 'auto';
    audio.volume = this._volume;
    audio.playbackRate = this.playbackRate;
  }

  _resetAudioElement(audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the currently active Audio element.
   */
  _getActive() {
    return this.audio;
  }

  // ---------------------------------------------------------------------------
  // Chapter loading
  // ---------------------------------------------------------------------------

  /**
   * Load a chapter for playback.
   * Fetches the chunk manifest and prepares the first chunk.
   */
  async loadChapter(bookId, chapterIndex) {
    const gen = ++this._generation;
    this._cancelRequests();
    this._cancelPollWait?.();
    for (const cancel of [...this._pendingAudioLoads]) cancel();
    this._requestController = new AbortController();
    this._stopPolling();
    this._detachEvents();
    this.pause();

    this.bookId = bookId;
    this.chapterIndex = chapterIndex;
    this.currentChunk = 0;
    this.chunkDurations = [];
    this._preloadedChunk = -1;
    this._preloadReady = false;
    this._preloadToken++;
    this._manifestRefreshFailures = 0;
    this.servedTier = null; // re-resolve tier at every chapter boundary

    this._resetAudioElement(this.audio);

    try {
      const manifest = await this._fetchManifest(this._requestController.signal);
      if (gen !== this._generation) return;
      this._applyManifest(manifest);
    } catch (err) {
      if (gen === this._generation) {
        this._emitError(err);
        throw err;
      }
      throw err;
    }

    this.totalChunks = this.manifest.totalChunks;
    this.chunkDurations = new Array(this.totalChunks).fill(null);

    // Handle empty chapters (no text, no chunks)
    if (this.totalChunks === 0) {
      if (this.onReady) this.onReady();
      return;
    }

    // Wait for first chunk to be ready
    const firstChunk = this.manifest.chunks && this.manifest.chunks[0];
    if (!firstChunk || firstChunk.status !== 'ready') {
      this._emitWaiting('Preparing narration…');
      this._emitPreparing('Preparing narration…', 0);
      await this._pollUntilChunkReady(0, gen);
      if (gen !== this._generation) return;
    }

    // Load first chunk into the active player
    try {
      await this._loadChunkInto(this._getActive(), 0);
    } catch (err) {
      if (gen === this._generation) this._emitError(err);
      throw err;
    }
    if (gen !== this._generation) return;

    // Preload second chunk if available
    if (this.totalChunks > 1) {
      this._preloadNext(1);
    }

    this._attachEvents();
    if (this.onReady) this.onReady();
  }

  /**
   * Fetch the chunk manifest from the server.
   */
  async _fetchManifest(signal = this._requestController?.signal) {
    // Once a chapter starts on a tier (instant vs premium), stay on it for
    // the whole chapter — no mid-chapter voice swaps. The pin is cleared on
    // the next chapter load, where the server picks the best available tier.
    const tierPin = this.servedTier ? `?tier=${encodeURIComponent(this.servedTier)}` : '';
    const url = `/api/chunks/${encodeURIComponent(this.bookId)}/${this.chapterIndex}/manifest${tierPin}`;
    const res = await this._raceWithAbort(fetch(url, { signal }), signal);
    if (!res.ok) {
      throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    }
    const manifest = await res.json();
    return manifest;
  }

  _raceWithAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new LifecycleCancelledError('Chapter load cancelled'));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new LifecycleCancelledError('Chapter load cancelled'));
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); }
      );
    });
  }

  _cancelRequests() {
    this._requestController?.abort();
    this._requestController = null;
  }

  _applyManifest(manifest) {
    this.manifest = manifest;
    if (manifest && manifest.servedTier) this.servedTier = manifest.servedTier;
  }

  /**
   * Refresh the manifest (to check for newly generated chunks).
   */
  async _refreshManifest(expectedGeneration = this._generation) {
    try {
      const manifest = await this._fetchManifest();
      if (expectedGeneration !== this._generation) return false;
      this._applyManifest(manifest);
      this._manifestRefreshFailures = 0;
      this.totalChunks = this.manifest.totalChunks;
      // Grow durations array if needed
      while (this.chunkDurations.length < this.totalChunks) {
        this.chunkDurations.push(null);
      }
      return true;
    } catch (err) {
      if (expectedGeneration !== this._generation || err?.cancelled) return false;
      this._manifestRefreshFailures++;
      console.warn('Manifest refresh failed:', err);
      return false;
    }
  }

  async _prioritizeChunk(chunkIndex) {
    if (!this.bookId || this.chapterIndex === null || this.chapterIndex === undefined) return;

    try {
      const tierPin = this.servedTier ? `?tier=${encodeURIComponent(this.servedTier)}` : '';
      await fetch(`/api/chunks/${encodeURIComponent(this.bookId)}/${this.chapterIndex}/${chunkIndex}/prioritize${tierPin}`, {
        method: 'POST'
      });
    } catch (err) {
      console.warn(`Failed to prioritize chunk ${chunkIndex}:`, err);
    }
  }

  /**
   * Check whether a given chunk is ready (status === 'ready') in the manifest.
   */
  _isChunkReady(chunkIndex) {
    if (!this.manifest || !this.manifest.chunks) return false;
    const chunk = this.manifest.chunks[chunkIndex];
    return chunk && chunk.status === 'ready';
  }

  _chunkStatus(chunkIndex) {
    if (!this.manifest || !this.manifest.chunks) return 'pending';
    const chunk = this.manifest.chunks[chunkIndex];
    return chunk ? chunk.status : 'pending';
  }

  /**
   * Poll the manifest until a specific chunk is ready.
   * Returns a promise that resolves when the chunk is available.
   */
  _pollUntilChunkReady(chunkIndex, expectedGeneration = this._generation) {
    this._cancelPollWait?.();
    return new Promise((resolve, reject) => {
      if (this._destroyed) return reject(new Error('Player destroyed'));
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (this._cancelPollWait === cancel) this._cancelPollWait = null;
        this._stopPolling();
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new LifecycleCancelledError('Chunk preparation cancelled'));
      this._cancelPollWait = cancel;

      const check = async () => {
        if (settled || expectedGeneration !== this._generation) {
          finish();
          return;
        }
        if (this._destroyed) {
          finish(new Error('Player destroyed'));
          return;
        }
        const refreshed = await this._refreshManifest(expectedGeneration);
        if (settled || expectedGeneration !== this._generation) {
          finish();
          return;
        }
        if (!refreshed) {
          if (this._manifestRefreshFailures >= 3) {
            const err = new Error('Server connection lost while preparing audio. Check that Xandrio is still running.');
            this._emitError(err);
            finish(err);
            return;
          }
          this._pollTimer = setTimeout(check, 2000);
          return;
        }

        this._emitPreparing(
          chunkIndex === 0 ? 'Preparing narration…' : 'Preparing upcoming audio…',
          chunkIndex
        );

        if (this._chunkStatus(chunkIndex) === 'error') {
          const err = new Error('Narration failed to prepare for this part of the chapter.');
          this._emitError(err);
          finish(err);
          return;
        }

        if (this._isChunkReady(chunkIndex)) {
          finish();
        } else {
          this._pollTimer = setTimeout(check, 2000);
        }
      };

      // First check immediately (manifest may already be fresh). When it
      // isn't, run a refresh right away instead of waiting a timer tick —
      // background tabs throttle timers to a minute or more, but fetches
      // run unthrottled, so a stale manifest must not cost a timer cycle.
      if (this._isChunkReady(chunkIndex)) {
        finish();
      } else {
        check();
      }
    });
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Chunk loading
  // ---------------------------------------------------------------------------

  /**
   * Build the URL for a specific chunk.
   */
  _chunkUrl(chunkIndex) {
    // Prefer the manifest's per-chunk URL — it carries the served tier
    // (?tier=instant|premium). Rebuilding the URL without it would hit the
    // default (premium) variant, 404 while premium is still rendering, and
    // surface as a media "Format error".
    const manifestUrl = this.manifest?.chunks?.[chunkIndex]?.url;
    if (manifestUrl) return manifestUrl;
    const tierPin = this.servedTier ? `?tier=${encodeURIComponent(this.servedTier)}` : '';
    return `/api/chunks/${encodeURIComponent(this.bookId)}/${this.chapterIndex}/${chunkIndex}${tierPin}`;
  }

  /**
   * Load a chunk into a specific Audio element.
   * Returns a promise that resolves when loadedmetadata fires.
   */
  async _loadChunkInto(audioEl, chunkIndex, retries = this._maxChunkLoadRetries, expectedGeneration = this._generation) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (expectedGeneration !== this._generation) return;
      try {
        await this._loadChunkIntoOnce(audioEl, chunkIndex);
        return;
      } catch (err) {
        if (expectedGeneration !== this._generation) return;
        lastError = err;
        if (this._destroyed || attempt >= retries) break;
        await this._refreshManifest(expectedGeneration);
        if (expectedGeneration !== this._generation) return;
        if (!this._isChunkReady(chunkIndex)) break;
        await this._delay(this._retryDelayMs * (attempt + 1));
      }
    }

    throw lastError || new Error(`Failed to load chunk ${chunkIndex}`);
  }

  _loadChunkIntoOnce(audioEl, chunkIndex) {
    if (this._destroyed) return Promise.reject(new Error('Player destroyed'));
    const wait = waitForMediaEvents(audioEl, {
      resolveEvents: ['loadedmetadata'],
      rejectEvents: ['error'],
      timeoutMs: this._chunkLoadTimeoutMs,
      timeoutError: () => new Error(`Chunk ${chunkIndex} media load timed out`),
      eventError: () => {
        const detail = audioEl.error && (audioEl.error.message || audioEl.error.code);
        return new Error(`Failed to load chunk ${chunkIndex}: ${detail || 'unknown error'}`);
      },
      cancelledError: () => new LifecycleCancelledError('Chunk media load cancelled')
    });
    this._pendingAudioLoads.add(wait.cancel);
    wait.promise.finally(() => this._pendingAudioLoads.delete(wait.cancel)).catch(() => {});
    audioEl.src = this._chunkUrl(chunkIndex);
    audioEl.volume = this._volume;
    audioEl.playbackRate = this.playbackRate;
    audioEl.load();
    return wait.promise.then(() => {
      if (audioEl.duration && isFinite(audioEl.duration)) this.chunkDurations[chunkIndex] = audioEl.duration;
    });
  }

  /**
   * Start preloading the next chunk in the standby player.
   */
  async _preloadNext(chunkIndex) {
    if (chunkIndex >= this.totalChunks) return;

    const preloadToken = ++this._preloadToken;
    this._preloadedChunk = chunkIndex;
    this._preloadReady = false;

    await this._refreshManifest();
    if (!this._isChunkReady(chunkIndex)) {
      await this._prioritizeChunk(chunkIndex);
      this._emitPreparing('Preparing upcoming audio…', chunkIndex);
      try {
        await this._waitForChunkReadyInBackground(chunkIndex, preloadToken);
      } catch (err) {
        if (!this._destroyed) console.warn(`Background preparation of chunk ${chunkIndex} failed:`, err);
        return;
      }
    }

    if (this._destroyed || preloadToken !== this._preloadToken || this.currentChunk >= chunkIndex) return;

    this._preloadReady = true;
  }

  async _waitForChunkReadyInBackground(chunkIndex, preloadToken) {
    while (!this._destroyed && preloadToken === this._preloadToken && this.currentChunk < chunkIndex) {
      await this._delay(1500);
      if (this._destroyed || preloadToken !== this._preloadToken || this.currentChunk >= chunkIndex) return;
      await this._refreshManifest();
      this._emitPreparing('Preparing upcoming audio…', chunkIndex);
      if (this._chunkStatus(chunkIndex) === 'error') {
        throw new Error('Upcoming narration failed to prepare.');
      }
      if (this._isChunkReady(chunkIndex)) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  _attachEvents() {
    const active = this._getActive();
    active.addEventListener('ended', this._onActiveEnded);
    active.addEventListener('timeupdate', this._onActiveTimeUpdate);
    active.addEventListener('error', this._onActiveError);
  }

  _detachEvents() {
    this.audio.removeEventListener('ended', this._onActiveEnded);
    this.audio.removeEventListener('timeupdate', this._onActiveTimeUpdate);
    this.audio.removeEventListener('error', this._onActiveError);
  }

  /**
   * Called when the active player finishes playing a chunk.
   */
  async _handleActiveEnded() {
    const gen = this._generation;
    const nextChunk = this.currentChunk + 1;

    // Chapter complete
    if (nextChunk >= this.totalChunks) {
      this._isPlaying = false;
      this._detachEvents();
      if (this.onChapterEnd) this.onChapterEnd();
      return;
    }

    // Check if the server has prepared the next source.
    if (this._preloadedChunk === nextChunk && this._preloadReady) {
      await this._transitionToNextChunk(nextChunk);
    } else {
      // Next chunk not ready — pause and wait
      this._prioritizeChunk(nextChunk);
      this._emitWaiting('Preparing upcoming audio…');
      this._emitPreparing('Preparing upcoming audio…', nextChunk);
      try {
        await this._pollUntilChunkReady(nextChunk);
      } catch (err) {
        return;
      }
      if (gen !== this._generation) return; // chapter changed while waiting

      await this._transitionToNextChunk(nextChunk);
    }
  }

  /**
   * Continue on the same media element by changing its source.
   */
  async _transitionToNextChunk(chunkIndex) {
    const gen = this._generation;
    this._detachEvents();
    const active = this._getActive();
    try {
      await this._loadChunkInto(active, chunkIndex);
    } catch (err) {
      if (gen === this._generation) this._emitError(err);
      return;
    }
    if (gen !== this._generation) return;

    this.currentChunk = chunkIndex;
    this._attachEvents();

    if (this._isPlaying) {
      try {
        await this._playActiveWithRetry();
      } catch (err) {
        this._isPlaying = false;
        this._emitError(err);
        return;
      }
    }

    if (this.onChunkChange) this.onChunkChange(chunkIndex);

    // Preload the chunk after this one
    this._preloadNext(chunkIndex + 1);
  }

  _handleTimeUpdate() {
    if (this.onTimeUpdate) {
      const currentTime = this.getCurrentTime();
      const totalTime = this.getTotalTime();
      this.onTimeUpdate({
        chunk: this.currentChunk,
        chunkIndex: this.currentChunk,
        chunkTime: this._getActive().currentTime,
        chunkDuration: this._getActive().duration || 0,
        currentTime,
        totalTime,
        totalEstimatedTime: currentTime,
        progressPercent: this.getProgressPercent(),
        totalChunks: this.totalChunks,
        isPlaying: this._isPlaying,
      });
    }
  }

  _handleError(e) {
    const msg = e && e.target && e.target.error
      ? e.target.error.message
      : 'Audio playback error';
    this._emitError(new Error(msg));
  }

  // ---------------------------------------------------------------------------
  // Playback controls
  // ---------------------------------------------------------------------------

  /**
   * Start or resume playback.
   */
  async play() {
    if (this._destroyed) return;
    this._isPlaying = true;
    try {
      await this._playActiveWithRetry();
    } catch (err) {
      this._isPlaying = false;
      throw err;
    }
  }

  async _playActiveWithRetry(retries = this._maxPlayRetries) {
    const active = this._getActive();

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await active.play();
        return;
      } catch (err) {
        lastError = err;
        // Browser autoplay/user-gesture failures are not transient; do not hide them.
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) break;
        if (this._destroyed || attempt >= retries) break;
        await this._delay(this._retryDelayMs * (attempt + 1));
      }
    }
    throw lastError || new Error('Audio playback failed');
  }

  /**
   * Pause playback.
   */
  pause() {
    this._isPlaying = false;
    this.audio.pause();
  }

  /**
   * Whether audio is currently playing.
   */
  get isPlaying() {
    return this._isPlaying;
  }

  /**
   * Seek to an absolute time (in seconds) within the current chunk.
   * If the time exceeds the chunk boundary, seek across chunks.
   */
  async seek(seconds) {
    if (this._destroyed) return;
    if (seconds < 0) seconds = 0;

    const active = this._getActive();
    const chunkDuration = active.duration;

    // If seeking within the current chunk, just set currentTime
    if (chunkDuration && seconds >= 0 && seconds <= chunkDuration) {
      active.currentTime = seconds;
      return;
    }

    // Otherwise, treat as an absolute chapter-time seek
    await this._seekToChapterTime(seconds);
  }

  /**
   * Seek to an exact chunk and offset. Useful for restoring persisted positions.
   */
  async seekToChunk(chunkIndex, chunkTime = 0) {
    if (this._destroyed || this.totalChunks === 0) return;

    const gen = this._generation;
    const targetChunk = Math.max(0, Math.min(this.totalChunks - 1, Math.floor(chunkIndex || 0)));
    const targetTime = Math.max(0, Number(chunkTime) || 0);
    const wasPlaying = this._isPlaying;

    this._detachEvents();
    this.pause();

    await this._refreshManifest();
    if (gen !== this._generation) return; // chapter changed while refreshing
    if (!this._isChunkReady(targetChunk)) {
      await this._prioritizeChunk(targetChunk);
      if (gen !== this._generation) return;
      this._emitWaiting('Generating audio…');
      try {
        await this._pollUntilChunkReady(targetChunk);
      } catch {
        if (gen === this._generation) this._attachEvents();
        return;
      }
      if (gen !== this._generation) return;
    }

    const active = this._getActive();
    try {
      if (targetChunk !== this.currentChunk || !active.src) {
        await this._loadChunkInto(active, targetChunk);
      }
    } catch (err) {
      if (gen === this._generation) {
        this._attachEvents();
        this._emitError(err);
      }
      return;
    }
    if (gen !== this._generation) return;

    this.currentChunk = targetChunk;
    active.currentTime = Math.min(targetTime, active.duration || targetTime);
    this._preloadedChunk = -1;
    this._preloadReady = false;

    this._attachEvents();
    if (this.onChunkChange) this.onChunkChange(targetChunk);
    this._handleTimeUpdate();

    this._preloadNext(targetChunk + 1);

    if (wasPlaying) {
      try {
        await this.play();
      } catch (err) {
        this._emitError(err);
      }
    }
  }

  /**
   * Skip forward or backward by a number of seconds, across chunk boundaries.
   */
  async skip(seconds) {
    const currentAbsolute = this.getCurrentTime();
    const targetTime = Math.max(0, currentAbsolute + seconds);
    await this._seekToChapterTime(targetTime);
  }

  /**
   * Set playback speed.
   */
  setSpeed(rate) {
    this.playbackRate = rate;
    this.audio.playbackRate = rate;
  }

  /**
   * Set volume (0.0–1.0).
   */
  setVolume(vol) {
    this._volume = Math.max(0, Math.min(1, vol));
    this.audio.volume = this._volume;
  }

  /**
   * Get the current volume.
   */
  getVolume() {
    return this._volume;
  }

  /**
   * Get current position info.
   */
  getPosition() {
    const active = this._getActive();
    const currentTime = this.getCurrentTime();
    const totalTime = this.getTotalTime();
    return {
      chunk: this.currentChunk,
      chunkIndex: this.currentChunk,
      chunkTime: active.currentTime || 0,
      chunkDuration: active.duration || 0,
      currentTime,
      totalTime,
      totalEstimatedTime: currentTime,
      progressPercent: this.getProgressPercent(),
      totalChunks: this.totalChunks,
      isPlaying: this._isPlaying,
      backend: this.backend,
    };
  }

  /**
   * Clean up the media element and stop all timers.
   */
  cancelPendingLoad() {
    this._generation++;
    this._preloadToken++;
    this._cancelRequests();
    this._cancelPollWait?.();
    for (const cancel of [...this._pendingAudioLoads]) cancel();
    this._stopPolling();
    this._detachEvents();
    this.pause();
  }

  destroy() {
    this._destroyed = true;
    this.cancelPendingLoad();

    this._resetAudioElement(this.audio);

    this.manifest = null;
    this.chunkDurations = [];
    this.onTimeUpdate = null;
    this.onChunkChange = null;
    this.onChapterEnd = null;
    this.onError = null;
    this.onReady = null;
    this.onWaiting = null;
    this.onPreparing = null;
  }

  // ---------------------------------------------------------------------------
  // Progress / time calculation
  // ---------------------------------------------------------------------------

  /**
   * Estimated total chapter duration (sum of known + estimated unknown).
   */
  getTotalTime() {
    const known = this.chunkDurations.filter((d) => d !== null);
    if (known.length === 0) return 0;

    const knownSum = known.reduce((a, b) => a + b, 0);
    const avgDuration = knownSum / known.length;
    const unknownCount = this.totalChunks - known.length;

    return knownSum + unknownCount * avgDuration;
  }

  /**
   * Current playback time within the chapter (across all chunks).
   */
  getCurrentTime() {
    let elapsed = 0;
    for (let i = 0; i < this.currentChunk; i++) {
      elapsed += this.chunkDurations[i] || this._avgChunkDuration();
    }
    elapsed += this._getActive().currentTime || 0;
    return elapsed;
  }

  /**
   * Get progress as a percentage (0–100) across the full chapter.
   */
  getProgressPercent() {
    const total = this.getTotalTime();
    if (total <= 0) return 0;
    return Math.min(100, (this.getCurrentTime() / total) * 100);
  }

  /**
   * Seek to a percentage of the full chapter.
   */
  async seekToPercent(pct) {
    pct = Math.max(0, Math.min(100, pct));
    const total = this.getTotalTime();
    if (total <= 0) return;
    await this._seekToChapterTime((pct / 100) * total);
  }

  // ---------------------------------------------------------------------------
  // Internal seeking logic
  // ---------------------------------------------------------------------------

  /**
   * Seek to an absolute time (in seconds) within the chapter.
   * Finds the target chunk and offset, loads it if needed.
   */
  async _seekToChapterTime(targetTime) {
    if (this.totalChunks === 0) return;

    const avg = this._avgChunkDuration();
    let accumulated = 0;
    let targetChunk = 0;
    let offset = 0;

    for (let i = 0; i < this.totalChunks; i++) {
      const dur = this.chunkDurations[i] || avg;
      if (accumulated + dur > targetTime) {
        targetChunk = i;
        offset = targetTime - accumulated;
        break;
      }
      accumulated += dur;
      // If we've gone past all chunks, clamp to last chunk's end
      if (i === this.totalChunks - 1) {
        targetChunk = i;
        offset = dur; // end of last chunk
      }
    }

    await this.seekToChunk(targetChunk, offset);
  }

  /**
   * Average duration of known chunks (fallback for estimation).
   */
  _avgChunkDuration() {
    const known = this.chunkDurations.filter((d) => d !== null);
    if (known.length === 0) return 10; // conservative default
    return known.reduce((a, b) => a + b, 0) / known.length;
  }

  // ---------------------------------------------------------------------------
  // Callback helpers
  // ---------------------------------------------------------------------------

  _emitError(err) {
    console.error('[ChunkPlayer]', err);
    if (this.onError) this.onError(err);
  }

  _emitWaiting(message) {
    if (this.onWaiting) this.onWaiting(message);
  }

  _emitPreparing(message, targetChunk = 0) {
    if (!this.onPreparing || !this.manifest || !Array.isArray(this.manifest.chunks)) return;

    const totalChunks = this.manifest.totalChunks || this.manifest.chunks.length || 0;
    const readyChunks = this.manifest.chunks.filter((chunk) => chunk.status === 'ready').length;
    const generatingChunks = this.manifest.chunks.filter((chunk) => chunk.status === 'generating').length;
    const queuedChunks = this.manifest.chunks.filter((chunk) => chunk.status === 'queued').length;
    const target = this.manifest.chunks[targetChunk] || null;
    const percent = totalChunks > 0 ? Math.round((readyChunks / totalChunks) * 100) : 100;

    this.onPreparing({
      message,
      targetChunk,
      targetStatus: target ? target.status : 'pending',
      totalChunks,
      readyChunks,
      generatingChunks,
      queuedChunks,
      percent
    });
  }
}

// Expose globally for script-tag usage
window.ChunkPlayer = ChunkPlayer;
