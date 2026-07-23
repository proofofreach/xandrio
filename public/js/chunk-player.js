/**
 * ChunkPlayer - Double-buffered chunked audio playback
 * 
 * Plays chapter audio as a sequence of pre-generated audio chunks with
 * seamless gapless transitions using two alternating Audio elements.
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

class ChunkPlayer {
  constructor(options = {}) {
    // Two audio elements for double-buffering
    this.audioA = new Audio();
    this.audioB = new Audio();

    // Which player is currently active ('A' or 'B')
    this.activePlayer = 'A';

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

    // Polling handle for manifest checks
    this._pollTimer = null;
    this._timeUpdateTimer = null;
    this._manifestRefreshFailures = 0;

    // Preload state tracking
    this._preloadedChunk = -1; // chunk index loaded in standby player
    this._preloadReady = false; // whether standby player is ready to play
    this._preloadToken = 0;
    // Incremented on every loadChapter()/destroy(). Async chains capture it
    // on entry and bail after each await if a newer chapter has taken over,
    // so an in-flight transition can't mutate the new chapter's state.
    this._generation = 0;

    // Bind event handlers so they can be added/removed
    this._onActiveEnded = this._handleActiveEnded.bind(this);
    this._onActiveTimeUpdate = this._handleTimeUpdate.bind(this);
    this._onActiveError = this._handleError.bind(this);

    this._setupAudioElement(this.audioA);
    this._setupAudioElement(this.audioB);
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
    return this.activePlayer === 'A' ? this.audioA : this.audioB;
  }

  /**
   * Get the standby (preloading) Audio element.
   */
  _getStandby() {
    return this.activePlayer === 'A' ? this.audioB : this.audioA;
  }

  /**
   * Swap active ↔ standby.
   */
  _swap() {
    this.activePlayer = this.activePlayer === 'A' ? 'B' : 'A';
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
    this.activePlayer = 'A';
    this.servedTier = null; // re-resolve tier at every chapter boundary

    // Reset both audio elements
    this._resetAudioElement(this.audioA);
    this._resetAudioElement(this.audioB);

    try {
      this.manifest = await this._fetchManifest();
    } catch (err) {
      if (gen === this._generation) this._emitError(err);
      return;
    }
    if (gen !== this._generation) return;

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
      await this._pollUntilChunkReady(0);
      if (gen !== this._generation) return;
    }

    // Load first chunk into the active player
    await this._loadChunkInto(this._getActive(), 0);
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
  async _fetchManifest() {
    // Once a chapter starts on a tier (instant vs premium), stay on it for
    // the whole chapter — no mid-chapter voice swaps. The pin is cleared on
    // the next chapter load, where the server picks the best available tier.
    const tierPin = this.servedTier ? `?tier=${encodeURIComponent(this.servedTier)}` : '';
    const url = `/api/chunks/${encodeURIComponent(this.bookId)}/${this.chapterIndex}/manifest${tierPin}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    }
    const manifest = await res.json();
    if (manifest && manifest.servedTier) {
      this.servedTier = manifest.servedTier;
    }
    return manifest;
  }

  /**
   * Refresh the manifest (to check for newly generated chunks).
   */
  async _refreshManifest() {
    try {
      this.manifest = await this._fetchManifest();
      this._manifestRefreshFailures = 0;
      this.totalChunks = this.manifest.totalChunks;
      // Grow durations array if needed
      while (this.chunkDurations.length < this.totalChunks) {
        this.chunkDurations.push(null);
      }
      return true;
    } catch (err) {
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
  _pollUntilChunkReady(chunkIndex) {
    return new Promise((resolve, reject) => {
      if (this._destroyed) return reject(new Error('Player destroyed'));

      const check = async () => {
        if (this._destroyed) {
          reject(new Error('Player destroyed'));
          return;
        }
        const refreshed = await this._refreshManifest();
        if (!refreshed) {
          if (this._manifestRefreshFailures >= 3) {
            this._stopPolling();
            const err = new Error('Server connection lost while preparing audio. Check that Xandrio is still running.');
            this._emitError(err);
            reject(err);
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
          this._stopPolling();
          const err = new Error('Narration failed to prepare for this part of the chapter.');
          this._emitError(err);
          reject(err);
          return;
        }

        if (this._isChunkReady(chunkIndex)) {
          this._stopPolling();
          resolve();
        } else {
          this._pollTimer = setTimeout(check, 2000);
        }
      };

      // First check immediately (manifest may already be fresh)
      if (this._isChunkReady(chunkIndex)) {
        resolve();
      } else {
        this._pollTimer = setTimeout(check, 2000);
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
  async _loadChunkInto(audioEl, chunkIndex, retries = this._maxChunkLoadRetries) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this._loadChunkIntoOnce(audioEl, chunkIndex);
        return;
      } catch (err) {
        lastError = err;
        if (this._destroyed || attempt >= retries) break;
        await this._refreshManifest();
        if (!this._isChunkReady(chunkIndex)) break;
        await this._delay(this._retryDelayMs * (attempt + 1));
      }
    }

    throw lastError || new Error(`Failed to load chunk ${chunkIndex}`);
  }

  _loadChunkIntoOnce(audioEl, chunkIndex) {
    return new Promise((resolve, reject) => {
      if (this._destroyed) return reject(new Error('Player destroyed'));

      const onMeta = () => {
        cleanup();
        // Record duration
        if (audioEl.duration && isFinite(audioEl.duration)) {
          this.chunkDurations[chunkIndex] = audioEl.duration;
        }
        resolve();
      };

      const onError = () => {
        cleanup();
        const detail = audioEl.error && (audioEl.error.message || audioEl.error.code);
        reject(new Error(`Failed to load chunk ${chunkIndex}: ${detail || 'unknown error'}`));
      };

      const cleanup = () => {
        audioEl.removeEventListener('loadedmetadata', onMeta);
        audioEl.removeEventListener('error', onError);
      };

      cleanup();
      audioEl.addEventListener('loadedmetadata', onMeta, { once: true });
      audioEl.addEventListener('error', onError, { once: true });

      audioEl.src = this._chunkUrl(chunkIndex);
      audioEl.volume = this._volume;
      audioEl.playbackRate = this.playbackRate;
      audioEl.load();
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

    try {
      await this._loadChunkInto(this._getStandby(), chunkIndex);
      if (this._destroyed || preloadToken !== this._preloadToken || this.currentChunk >= chunkIndex) return;
      this._preloadReady = true;
    } catch (err) {
      console.warn(`Preload of chunk ${chunkIndex} failed:`, err);
      this._preloadReady = false;
    }
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
    // Remove from both to be safe
    this.audioA.removeEventListener('ended', this._onActiveEnded);
    this.audioA.removeEventListener('timeupdate', this._onActiveTimeUpdate);
    this.audioA.removeEventListener('error', this._onActiveError);
    this.audioB.removeEventListener('ended', this._onActiveEnded);
    this.audioB.removeEventListener('timeupdate', this._onActiveTimeUpdate);
    this.audioB.removeEventListener('error', this._onActiveError);
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

    // Check if next chunk is preloaded and ready
    if (this._preloadedChunk === nextChunk && this._preloadReady) {
      this._transitionToNextChunk(nextChunk);
    } else {
      // Next chunk not ready — pause and wait
      this._emitWaiting('Preparing upcoming audio…');
      this._emitPreparing('Preparing upcoming audio…', nextChunk);
      try {
        await this._pollUntilChunkReady(nextChunk);
      } catch (err) {
        return;
      }
      if (gen !== this._generation) return; // chapter changed while waiting

      // Now load it into the standby player
      try {
        await this._loadChunkInto(this._getStandby(), nextChunk);
      } catch (err) {
        if (gen === this._generation) this._emitError(err);
        return;
      }
      if (gen !== this._generation) return;
      this._transitionToNextChunk(nextChunk);
    }
  }

  /**
   * Seamlessly transition to the next chunk (already loaded in standby).
   */
  _transitionToNextChunk(chunkIndex) {
    this._detachEvents();

    // Swap active ↔ standby
    this._swap();
    this.currentChunk = chunkIndex;

    // Apply current settings to the now-active player
    const active = this._getActive();
    active.volume = this._volume;
    active.playbackRate = this.playbackRate;

    this._attachEvents();

    if (this._isPlaying) {
      this._playActiveWithRetry().catch((err) => this._emitError(err));
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
    this._getStandby().pause();

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
    this.audioA.pause();
    this.audioB.pause();
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
   * Set playback speed on both audio elements.
   */
  setSpeed(rate) {
    this.playbackRate = rate;
    this.audioA.playbackRate = rate;
    this.audioB.playbackRate = rate;
  }

  /**
   * Set volume on both audio elements (0.0–1.0).
   */
  setVolume(vol) {
    this._volume = Math.max(0, Math.min(1, vol));
    this.audioA.volume = this._volume;
    this.audioB.volume = this._volume;
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
    };
  }

  /**
   * Clean up both audio elements and stop all timers.
   */
  destroy() {
    this._destroyed = true;
    this._generation++;
    this._stopPolling();
    this._detachEvents();
    this.pause();

    this._resetAudioElement(this.audioA);
    this._resetAudioElement(this.audioB);

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
