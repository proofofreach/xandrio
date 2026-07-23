/**
 * TTS Generation Queue with Concurrency Control
 * 
 * Manages Edge TTS generation requests with priority scheduling,
 * concurrency limiting, and status tracking.
 */

const { EventEmitter } = require('events');
const { EdgeTTS } = require('node-edge-tts');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const path = require('path');
const { buildMasteringArgs } = require('./audio-quality');
const TtsEngineAdapterRegistry = require('./tts-engine-adapters');
const {
  adaptNarrationForEngine,
  createEngineAdapterRegistry,
  ENGINE_DEFINITIONS,
  getKokoroAudioFormat,
  getChatterboxAudioFormat
} = TtsEngineAdapterRegistry;
const {
  isKokoroVoice,
  getKokoroVoiceName
} = require('./kokoro-tuning');
const {
  isChatterboxVoice,
  getChatterboxVoiceName
} = require('./chatterbox-tuning');
const { prepareTtsText, isSpeakableText } = require('./tts-text');
const { synthesizeEdgeTts } = require('./abortable-edge-tts');
const { outputFormatFromPath } = require('./tts-output-format');

// Priority weights — lower number = higher priority
const PRIORITY_ORDER = {
  immediate: 0,
  next: 1,
  background: 2
};

function getVoiceForLanguage(language, overrideVoice) {
  const voices = {
    'en': { voice: 'en-US-AndrewMultilingualNeural', lang: 'en-US' },
    'de': { voice: 'de-DE-FlorianMultilingualNeural', lang: 'de-DE' },
    'es': { voice: 'es-ES-AlvaroNeural', lang: 'es-ES' },
    'fr': { voice: 'fr-FR-RemyMultilingualNeural', lang: 'fr-FR' },
    'it': { voice: 'it-IT-GiuseppeMultilingualNeural', lang: 'it-IT' },
    'pt': { voice: 'pt-BR-AntonioNeural', lang: 'pt-BR' },
    'ru': { voice: 'ru-RU-DmitryNeural', lang: 'ru-RU' },
    'zh': { voice: 'zh-CN-YunxiNeural', lang: 'zh-CN' },
    'ja': { voice: 'ja-JP-KeitaNeural', lang: 'ja-JP' }
  };
  const base = voices[language] || voices['en'];
  // For English, allow user override
  if ((!language || language === 'en' || language === 'en-us') && overrideVoice) {
    return { voice: overrideVoice, lang: 'en-US' };
  }
  return base;
}

function getSettings() {
  try {
    const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
    const settingsPath = path.join(dataDir, 'settings.json');
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

function getKokoroVoice(voiceId) {
  return isKokoroVoice(voiceId) ? getKokoroVoiceName(voiceId) : 'af_heart';
}

function getKokoroLanguage(language, voice) {
  if (typeof voice === 'string' && voice.startsWith('bm_')) return 'en-gb';
  return language;
}

/**
 * Conservative floor for how short a chunk's audio can plausibly be. Real
 * narration runs ~12–18 chars/second; 45 chars/second is ~3x faster than
 * fast speech, so anything under it means the model collapsed mid-generation
 * (observed Chatterbox failure: a few seconds of speech, then silence).
 * Clamped low for tiny heading chunks where rate estimates are meaningless.
 */
function minExpectedChunkSeconds(text) {
  return Math.max(0.4, String(text || '').length / 45);
}

/**
 * ffmpeg args for the single WAV->playback-audio processing pass every HTTP-engine
 * chunk goes through (pure function so tests can assert the chain):
 *   1. Trim leading/trailing silence only — the areverse pair trims the tail
 *      with the same start-side filter; start_silence keeps a short natural
 *      breath and internal pauses are untouched.
 *   2. Apply a stable engine calibration gain plus true-peak limiting so
 *      short chunks do not make independent loudness decisions.
 *   3. Optional deterministic paragraph pause (after trimming, so the pause
 *      length doesn't depend on whatever trailing silence the model emitted).
 *   4. Resample to the engines' native 24kHz and encode the configured mono
 *      playback format. Changing anything here needs an AUDIO_PIPELINE_VERSION
 *      bump in lib/tts-engine-profile.js.
 */
function buildChunkEncodeArgs({ partPath, padEndMs = 0, outputFormat = null } = {}) {
  return buildMasteringArgs({ inputFormat: 'wav', outputPath: partPath, outputFormat, padEndMs });
}

function isWavBuffer(buffer) {
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE';
}

function isLikelyMp3Buffer(buffer) {
  return buffer.length >= 3 && (
    buffer.subarray(0, 3).toString('ascii') === 'ID3' ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function abortError(message = 'TTS generation cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done(abortError());
    function done(error) {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isTransientHttpTtsStatus(status) {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

class TTSQueue extends EventEmitter {
  /**
   * @param {Object} options
   * @param {number} [options.maxConcurrent=2] - Max simultaneous TTS generations
   * @param {string} [options.cacheDir] - Cache directory (informational; outputPath is per-job)
   * @param {number} [options.timeout=120000] - Per-job timeout in ms
   * @param {string} [options.defaultVoice='kokoro:am_michael'] - Voice used when settings are empty
   * @param {() => number} [options.maxConcurrentProvider] - Dynamic concurrency limit
   * @param {{run: Function}} [options.generationScheduler] - Shared admission
   *   scheduler for GPU-backed engines across queue instances
   */
  constructor(options = {}) {
    super();
    this.maxConcurrent = options.maxConcurrent || 2;
    this.cacheDir = options.cacheDir || null;
    this.timeout = options.timeout || 120000;
    this.defaultVoice = options.defaultVoice || 'kokoro:am_michael';
    this.maxConcurrentProvider = options.maxConcurrentProvider || null;
    this.generationScheduler = options.generationScheduler || null;
    this.edgeTtsRunner = options.edgeTtsRunner || synthesizeEdgeTts;
    this.engineAdapters = options.engineAdapters || createEngineAdapterRegistry({ queue: this });

    // Queue state
    this._queue = [];         // pending jobs, kept sorted by priority
    this._active = new Map(); // jobId -> job (currently generating)
    this._jobs = new Map();   // jobId -> job (all known jobs for lookup)
    this._jobsByOutputPath = new Map();
    this._completedCount = 0;

    // Finished jobs are retained (text dropped) so late waitFor()/getStatus()
    // calls still resolve, but only up to this cap — beyond it the oldest
    // finished jobs are evicted so _jobs can't grow without bound.
    this._finishedJobIds = [];
    this._maxFinishedJobs = options.maxFinishedJobs || 500;
  }

  /**
   * Retire a finished (complete/error) job: drop its text payload and evict
   * the oldest finished jobs beyond the retention cap.
   * @private
   */
  _retireJob(job) {
    job.text = null;
    job.narration = null;
    this._finishedJobIds.push(job.id);
    while (this._finishedJobIds.length > this._maxFinishedJobs) {
      this._jobs.delete(this._finishedJobIds.shift());
    }
  }

  /**
   * Enqueue a TTS generation job.
   * Returns the job id immediately (the promise resolves right away with the id).
   * Listen for 'complete' / 'error' events, or use waitFor(jobId) to await completion.
   * 
   * @param {Object} params
   * @param {string} params.text - Text to convert
   * @param {string} params.outputPath - Destination audio file path
   * @param {string} [params.language='en'] - Language code
   * @param {string} [params.priority='background'] - 'immediate' | 'next' | 'background'
   * @param {string} [params.voice] - Voice snapshot for this job
   * @param {number} [params.padEndMs=0] - Trailing silence (ms) appended to the
   *   encoded chunk (paragraph pause for paragraph-final chunks)
   * @returns {Promise<string>} Resolves immediately with jobId
   */
  async enqueue({ text, outputPath, language = 'en', priority = 'background', voice = null, padEndMs = 0, narration = null }) {
    const existingId = outputPath ? this._jobsByOutputPath.get(outputPath) : null;
    const existing = existingId ? this._jobs.get(existingId) : null;
    if (existing && (existing.status === 'queued' || existing.status === 'generating')) {
      if (this._isHigherPriority(priority, existing.priority)) {
        this.prioritize(existing.id, priority);
      }
      return existing.id;
    }
    if (existingId) {
      this._jobsByOutputPath.delete(outputPath);
    }

    const id = crypto.randomBytes(8).toString('hex');

    const completionPromise = new Promise((resolve, reject) => {
      const job = {
        id,
        text,
        outputPath,
        language,
        priority,
        voice,
        padEndMs,
        narration,
        status: 'queued',
        createdAt: Date.now(),
        resolve,
        reject
      };

      this._jobs.set(id, job);
      if (outputPath) this._jobsByOutputPath.set(outputPath, id);
      this._insertByPriority(job);

      // Kick the processing loop on the next tick so enqueue() returns first
      process.nextTick(() => this._drain());
    });

    // Stash the completion promise on the job so waitFor() can access it
    // Add a no-op catch to prevent unhandled promise rejections when nobody awaits
    completionPromise.catch(() => {});
    this._jobs.get(id)._completionPromise = completionPromise;

    return id;
  }

  /**
   * Wait for a job to complete.
   * @param {string} jobId
   * @returns {Promise<string>} Resolves with outputPath when done, rejects on error
   */
  waitFor(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) {
      return Promise.reject(new Error(`Unknown job: ${jobId}`));
    }
    if (job.status === 'complete') {
      return Promise.resolve(job.outputPath);
    }
    if (job.status === 'error') {
      return Promise.reject(job._error || new Error('Job failed'));
    }
    return job._completionPromise;
  }

  /**
   * Get the status of a specific job.
   * @param {string} jobId
   * @returns {{ status: string, position: number|undefined } | null}
   */
  getStatus(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return null;

    let position;
    if (job.status === 'queued') {
      position = this._queue.findIndex(j => j.id === jobId);
      if (position === -1) position = undefined;
    } else if (job.status === 'generating') {
      position = 0;
    }

    return {
      status: job.status,
      position
    };
  }

  /**
   * Get global queue status.
   * @returns {{ active: number, queued: number, completed: number }}
   */
  getQueueStatus() {
    return {
      active: this._active.size,
      queued: this._queue.length,
      completed: this._completedCount
    };
  }

  /**
   * Whether the queue holds live-playback work (immediate/next priority),
   * either active or pending. Background schedulers (premium prep) yield
   * while this is true — both engines share the GPU.
   * @returns {boolean}
   */
  hasForegroundWork() {
    for (const job of this._active.values()) {
      if (job.priority === 'immediate' || job.priority === 'next') return true;
    }
    return this._queue.some(job => job.priority === 'immediate' || job.priority === 'next');
  }

  /**
   * Cancel a queued job. Only works for jobs still in 'queued' status.
   * @param {string} jobId
   * @returns {boolean} true if cancelled, false if not found or already processing
   */
  cancel(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'generating') {
      job._cancelRequested = true;
      job._controller?.abort();
      job._admission?.cancel?.();
      return true;
    }
    if (job.status !== 'queued') return false;

    // Remove from queue
    const idx = this._queue.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      this._queue.splice(idx, 1);
    }

    job.status = 'cancelled';
    if (job.outputPath && this._jobsByOutputPath.get(job.outputPath) === job.id) {
      this._jobsByOutputPath.delete(job.outputPath);
    }
    const cancelErr = new Error('Job cancelled');
    job.reject(cancelErr);

    // Prevent unhandled rejection on the stashed completion promise
    if (job._completionPromise) {
      job._completionPromise.catch(() => {});
    }

    this._jobs.delete(jobId);

    return true;
  }

  prioritize(jobId, priority = 'immediate') {
    const job = this._jobs.get(jobId);
    if (!job || job.status !== 'queued') return false;

    const idx = this._queue.findIndex(j => j.id === jobId);
    if (idx === -1) return false;

    this._queue.splice(idx, 1);
    job.priority = priority;
    this._insertByPriority(job, { frontOfPriority: true });
    process.nextTick(() => this._drain());
    return true;
  }

  /**
   * Insert a job into the queue maintaining priority order.
   * Immediate-priority jobs go before next, which go before background.
   * Within the same priority, FIFO order is preserved.
   */
  _insertByPriority(job, { frontOfPriority = false } = {}) {
    const jobWeight = PRIORITY_ORDER[job.priority] ?? PRIORITY_ORDER.background;

    // Find the first job in the queue with a strictly lower priority (higher weight)
    let insertIdx = this._queue.length;
    for (let i = 0; i < this._queue.length; i++) {
      const existingWeight = PRIORITY_ORDER[this._queue[i].priority] ?? PRIORITY_ORDER.background;
      if (existingWeight > jobWeight || (frontOfPriority && existingWeight === jobWeight)) {
        insertIdx = i;
        break;
      }
    }

    this._queue.splice(insertIdx, 0, job);
  }

  _isHigherPriority(candidate, current) {
    const candidateWeight = PRIORITY_ORDER[candidate] ?? PRIORITY_ORDER.background;
    const currentWeight = PRIORITY_ORDER[current] ?? PRIORITY_ORDER.background;
    return candidateWeight < currentWeight;
  }

  _isForeground(job) {
    return job && (job.priority === 'immediate' || job.priority === 'next');
  }

  _takeNextRunnableJob(maxConcurrent) {
    if (this._active.size < maxConcurrent) {
      return this._queue.shift() || null;
    }

    // A long background render, especially premium Chatterbox prep, must not
    // pin live playback or a just-selected voice at queued forever. Let one
    // foreground job bypass a background-only active set.
    if ([...this._active.values()].some(job => this._isForeground(job))) {
      return null;
    }

    const foregroundIndex = this._queue.findIndex(job => this._isForeground(job));
    if (foregroundIndex === -1) return null;
    return this._queue.splice(foregroundIndex, 1)[0];
  }

  /**
   * Process queued jobs up to the concurrency limit.
   */
  _drain() {
    const maxConcurrent = this._getMaxConcurrent();
    while (this._queue.length > 0) {
      const job = this._takeNextRunnableJob(maxConcurrent);
      if (!job) break;
      this._processJob(job);
    }
  }

  _getMaxConcurrent() {
    if (!this.maxConcurrentProvider) return this.maxConcurrent;
    const provided = Number(this.maxConcurrentProvider());
    if (!Number.isFinite(provided) || provided <= 0) return this.maxConcurrent;
    return Math.max(1, Math.floor(provided));
  }

  /**
   * Process a single TTS job.
   */
  async _processJob(job) {
    job.status = 'generating';
    job._controller = new AbortController();
    this._active.set(job.id, job);

    this.emit('progress', {
      jobId: job.id,
      status: 'generating',
      active: this._active.size,
      queued: this._queue.length
    });

    try {
      const generate = async (admission = {}) => {
        const onAdmissionAbort = () => job._controller.abort();
        admission.signal?.addEventListener('abort', onAdmissionAbort, { once: true });
        if (admission.signal?.aborted) job._controller.abort();
        try {
          return await this._generateTTS(
            job.text,
            job.outputPath,
            job.language,
            job.voice,
            job.padEndMs,
            job._controller.signal,
            job.narration
          );
        } finally {
          admission.signal?.removeEventListener('abort', onAdmissionAbort);
        }
      };
      if (this.generationScheduler && this._usesGpu(job.voice)) {
        job._admission = this.generationScheduler.run({ resource: 'gpu', priority: job.priority }, generate);
        await job._admission;
      } else {
        await generate();
      }
      throwIfAborted(job._controller.signal);

      job.status = 'complete';
      this._completedCount++;
      this._active.delete(job.id);
      if (job.outputPath && this._jobsByOutputPath.get(job.outputPath) === job.id) {
        this._jobsByOutputPath.delete(job.outputPath);
      }

      this._retireJob(job);

      this.emit('complete', {
        jobId: job.id,
        outputPath: job.outputPath,
        active: this._active.size,
        queued: this._queue.length
      });

      job.resolve(job.outputPath);
    } catch (err) {
      if (job._cancelRequested) {
        job.status = 'cancelled';
        this._active.delete(job.id);
        if (job.outputPath && this._jobsByOutputPath.get(job.outputPath) === job.id) {
          this._jobsByOutputPath.delete(job.outputPath);
        }
        if (job.outputPath) await this._cleanupOutputArtifacts(job.outputPath);
        job.reject(new Error('Job cancelled'));
        this._jobs.delete(job.id);
        return;
      }
      job.status = 'error';
      job._error = err;
      this._active.delete(job.id);
      if (job.outputPath && this._jobsByOutputPath.get(job.outputPath) === job.id) {
        this._jobsByOutputPath.delete(job.outputPath);
      }

      this._retireJob(job);

      this.emit('error', {
        jobId: job.id,
        error: err,
        active: this._active.size,
        queued: this._queue.length
      });

      job.reject(err);
    } finally {
      // Continue draining the queue
      this._drain();
    }
  }

  _usesGpu(voice) {
    const selected = voice || getSettings().voice || this.defaultVoice;
    return Boolean(this.engineAdapters.resolve(selected).usesGpu);
  }

  /**
   * Perform the actual Edge TTS generation.
   * Override this method in tests to provide a mock.
   */
  async _generateTTS(text, outputPath, language = 'en', voice = null, padEndMs = 0, signal = null, narration = null) {
    const userVoice = voice || getSettings().voice || this.defaultVoice;
    const basePrepared = prepareTtsText(text);
    if (!isSpeakableText(basePrepared)) {
      throw new Error('TTS input has no speakable text');
    }

    const adapter = this.engineAdapters.resolve(userVoice);
    const adapted = adaptNarrationForEngine(adapter.id, basePrepared, narration, padEndMs);
    return adapter.generate({
      text: adapted.text,
      outputPath,
      language,
      voice: userVoice,
      padEndMs: adapted.padEndMs,
      signal,
      narration
    });
  }

  async _generateEdgeTTS({ text, outputPath, language, voice, padEndMs = 0, gainDb = 0, signal = null }) {
    const voiceConfig = getVoiceForLanguage(language, voice);

    const tts = new EdgeTTS({
      voice: voiceConfig.voice,
      lang: voiceConfig.lang,
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      timeout: this.timeout
    });

    // Generate to a temp path and rename so an interrupted run can never
    // leave a truncated file at outputPath (a size>0 file there is trusted
    // as a ready chunk by ChunkedTTS).
    const partPath = `${outputPath}.part`;
    try {
      await this.edgeTtsRunner(tts, text, partPath, signal);
    } catch (error) {
      await this._cleanupOutputArtifacts(outputPath);
      throw error;
    }
    if (signal?.aborted) {
      await fsp.unlink(partPath).catch(() => {});
      const error = new Error('TTS generation cancelled');
      error.name = 'AbortError';
      throw error;
    }

    // Verify the output file is not empty (TTS can silently produce 0-byte files)
    try {
      const stat = await fsp.stat(partPath);
      if (stat.size === 0) {
        await fsp.unlink(partPath).catch(() => {});
        throw new Error('TTS produced empty file');
      }
    } catch (err) {
      if (err.message === 'TTS produced empty file') throw err;
      throw new Error(`TTS output file missing: ${err.message}`);
    }
    await this._masterAudioFileToOutput(partPath, 'mp3', outputPath, padEndMs, gainDb, signal);
  }

  /** Write an audio buffer to outputPath atomically (temp file + rename). */
  async _writeAudioAtomic(outputPath, buffer) {
    const partPath = `${outputPath}.part`;
    await fsp.writeFile(partPath, buffer);
    await fsp.rename(partPath, outputPath);
  }

  async _generateHttpTTS(engine, text, outputPath, payloadExtras = {}, padEndMs = 0, gainDb = 0, signal = null) {
    // Truncation guard: Chatterbox can collapse mid-generation (a few seconds
    // of speech, then silence the trim step removes), which would otherwise
    // ship as silently missing sentences. Retry once, then fail the chunk
    // loudly rather than serve truncated audio.
    const minSeconds = minExpectedChunkSeconds(text);
    let lastDuration = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signal?.aborted) {
        await this._cleanupOutputArtifacts(outputPath);
        throw abortError();
      }
      try {
        await this._generateHttpTTSOnce(engine, text, outputPath, payloadExtras, padEndMs, gainDb, signal);
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          await this._cleanupOutputArtifacts(outputPath);
          throw abortError();
        }
        throw error;
      }
      if (signal?.aborted) {
        await this._cleanupOutputArtifacts(outputPath);
        throw abortError();
      }
      lastDuration = await this._probeChunkDurationSeconds(outputPath);
      if (signal?.aborted) {
        await this._cleanupOutputArtifacts(outputPath);
        throw abortError();
      }
      // Unprobeable output (ffprobe missing/failed) is not evidence of
      // truncation — accept it rather than loop.
      if (lastDuration === null || lastDuration >= minSeconds) return;
      console.warn(
        `[tts-queue] ${engine.label} output suspiciously short ` +
        `(${lastDuration.toFixed(1)}s for ${text.length} chars, expected >= ${minSeconds.toFixed(1)}s), ` +
        (attempt === 1 ? 'retrying' : 'giving up')
      );
    }
    await fsp.unlink(outputPath).catch(() => {});
    throw new Error(
      `${engine.label} produced truncated audio (${lastDuration.toFixed(1)}s for ${text.length} chars)`
    );
  }

  async _generateHttpTTSOnce(engine, text, outputPath, payloadExtras = {}, padEndMs = 0, gainDb = 0, signal = null) {
    throwIfAborted(signal);
    const response = await this._fetchHttpTTSWithRetry(engine, {
      text,
      format: engine.format(),
      ...payloadExtras
    }, signal);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${engine.label} failed (${response.status}): ${body || response.statusText}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    throwIfAborted(signal);
    if (audio.length === 0) {
      throw new Error(`${engine.label} produced empty audio`);
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('audio/wav') || isWavBuffer(audio)) {
      await this._convertWavBufferToOutput(audio, outputPath, padEndMs, gainDb, signal);
    } else if (contentType.includes('audio/mpeg') || isLikelyMp3Buffer(audio)) {
      // MP3 overrides cost another lossy encode, but must still honor the same
      // trim, loudness, peak, sample-rate, and paragraph-pause policy as WAV.
      await this._convertAudioBufferToOutput(audio, 'mp3', outputPath, padEndMs, gainDb, signal);
    } else {
      throw new Error(`${engine.label} returned unsupported audio type: ${contentType || 'unknown'}`);
    }

    const stat = await fsp.stat(outputPath);
    if (stat.size === 0) {
      await fsp.unlink(outputPath).catch(() => {});
      throw new Error(`${engine.label} produced empty audio file`);
    }
  }

  /** Decoded duration of a written chunk, or null when unprobeable. */
  _probeChunkDurationSeconds(filePath) {
    return new Promise((resolve) => {
      execFile('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath
      ], (err, stdout) => {
        if (err) return resolve(null);
        const value = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(value) ? value : null);
      });
    });
  }

  // Engine dispatch points — kept as named methods so tests and the
  // preferences sample route can stub or call one engine directly; both
  // delegate to the shared HTTP pipeline.
  async _generateKokoroTTS(text, outputPath, language, voice, padEndMs = 0, gainDb = 0, signal = null) {
    const engine = ENGINE_DEFINITIONS.find(definition => definition.id === 'kokoro');
    return this._generateHttpTTS(engine.http, text, outputPath, { language, voice }, padEndMs, gainDb, signal);
  }

  async _generateChatterboxTTS(text, outputPath, voice, padEndMs = 0, gainDb = 0, signal = null) {
    const engine = ENGINE_DEFINITIONS.find(definition => definition.id === 'chatterbox');
    return this._generateHttpTTS(engine.http, text, outputPath, { voice }, padEndMs, gainDb, signal);
  }

  async _fetchHttpTTSWithRetry(engine, payload, externalSignal = null) {
    const startedAt = Date.now();
    const deadline = startedAt + engine.timeout(this);
    const url = `${engine.baseUrl()}/tts`;
    let attempt = 0;
    let lastError = null;

    while (Date.now() < deadline) {
      throwIfAborted(externalSignal);
      attempt++;
      const controller = new AbortController();
      const abort = () => controller.abort();
      externalSignal?.addEventListener('abort', abort, { once: true });
      if (externalSignal?.aborted) controller.abort();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (response.ok || !isTransientHttpTtsStatus(response.status)) {
          return response;
        }

        lastError = new Error(`${engine.label} temporarily unavailable (${response.status})`);
      } catch (err) {
        lastError = err;
        if (externalSignal?.aborted) throw abortError();
        if (err.name === 'AbortError') break;
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abort);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const delay = Math.min(engine.backoffBaseMs * (2 ** Math.min(attempt - 1, 4)), engine.backoffMaxMs, remaining);
      await abortableSleep(delay, externalSignal);
    }

    const message = lastError?.message || `${engine.label} request failed`;
    throw new Error(`${engine.label} unavailable after ${Math.round((Date.now() - startedAt) / 1000)}s: ${message}`);
  }

  // Process a WAV chunk in one mastering pass: trim edge silence, normalize
  // loudness, optionally pad a paragraph pause, then encode the requested
  // playback format.
  async _convertWavBufferToOutput(wavBuffer, outputPath, padEndMs = 0, gainDb = 0, signal = null) {
    return this._convertAudioBufferToOutput(wavBuffer, 'wav', outputPath, padEndMs, gainDb, signal);
  }

  async _convertWavBufferToMp3(wavBuffer, outputPath, padEndMs = 0, gainDb = 0, signal = null) {
    return this._convertAudioBufferToMp3(wavBuffer, 'wav', outputPath, padEndMs, gainDb, signal);
  }

  async _convertAudioBufferToMp3(audioBuffer, inputFormat, outputPath, padEndMs = 0, gainDb = 0, signal = null) {
    return this._convertAudioBufferToOutput(audioBuffer, inputFormat, outputPath, padEndMs, gainDb, signal, 'mp3');
  }

  async _convertAudioBufferToOutput(audioBuffer, inputFormat, outputPath, padEndMs = 0, gainDb = 0, signal = null, outputFormat = null) {
    const finalFormat = outputFormat || outputFormatFromPath(outputPath);
    const partPath = `${outputPath}.part.${finalFormat}`;
    throwIfAborted(signal);
    try {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', buildMasteringArgs({ inputFormat, outputPath: partPath, outputFormat: finalFormat, padEndMs, gainDb }));

        const onAbort = () => ffmpeg.kill('SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });

        let stderr = '';
        ffmpeg.stderr.on('data', chunk => {
          stderr += chunk.toString();
        });
        ffmpeg.on('error', error => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        });
        // If ffmpeg fails to spawn or dies early, writing to its stdin emits
        // EPIPE on the stream — swallow it so it can't become an uncaught error
        // (the 'error'/'close' handlers above already reject the promise).
        ffmpeg.stdin.on('error', () => {});
        ffmpeg.on('close', code => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) {
            reject(abortError());
            return;
          }
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg audio conversion failed (${code}): ${stderr}`));
          }
        });
        ffmpeg.stdin.end(audioBuffer);
      });
      throwIfAborted(signal);
      await fsp.rename(partPath, outputPath);
    } finally {
      await fsp.unlink(partPath).catch(() => {});
      if (signal?.aborted) await fsp.unlink(outputPath).catch(() => {});
    }
  }

  async _cleanupOutputArtifacts(outputPath) {
    await Promise.all([
      outputPath,
      `${outputPath}.part`,
      `${outputPath}.part.mp3`,
      `${outputPath}.part.wav`
    ].map(filePath => fsp.unlink(filePath).catch(() => {})));
  }

  async _masterAudioFileToMp3(inputPath, inputFormat, outputPath, padEndMs = 0, gainDb = 0, signal = null) {
    return this._masterAudioFileToOutput(inputPath, inputFormat, outputPath, padEndMs, gainDb, signal, 'mp3');
  }

  async _masterAudioFileToOutput(inputPath, inputFormat, outputPath, padEndMs = 0, gainDb = 0, signal = null, outputFormat = null) {
    const finalFormat = outputFormat || outputFormatFromPath(outputPath);
    const partPath = `${outputPath}.part.${finalFormat}`;
    throwIfAborted(signal);
    try {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', buildMasteringArgs({ inputFormat, inputPath, outputPath: partPath, outputFormat: finalFormat, padEndMs, gainDb }));
        let stderr = '';
        const onAbort = () => ffmpeg.kill('SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });
        ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString(); });
        ffmpeg.on('error', error => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        });
        ffmpeg.on('close', code => {
          signal?.removeEventListener('abort', onAbort);
          if (signal?.aborted) return reject(abortError());
          code === 0
            ? resolve()
            : reject(new Error(`ffmpeg audio mastering failed (${code}): ${stderr}`));
        });
      });
      throwIfAborted(signal);
      await fsp.rename(partPath, outputPath);
    } finally {
      await fsp.unlink(inputPath).catch(() => {});
      await fsp.unlink(partPath).catch(() => {});
      if (signal?.aborted) await fsp.unlink(outputPath).catch(() => {});
    }
  }
}

module.exports = TTSQueue;
module.exports.getVoiceForLanguage = getVoiceForLanguage;
module.exports.isKokoroVoice = isKokoroVoice;
module.exports.getKokoroVoice = getKokoroVoice;
module.exports.getKokoroLanguage = getKokoroLanguage;
module.exports.getKokoroAudioFormat = getKokoroAudioFormat;
module.exports.isChatterboxVoice = isChatterboxVoice;
module.exports.getChatterboxVoiceName = getChatterboxVoiceName;
module.exports.getChatterboxAudioFormat = getChatterboxAudioFormat;
module.exports.buildChunkEncodeArgs = buildChunkEncodeArgs;
module.exports.minExpectedChunkSeconds = minExpectedChunkSeconds;
module.exports.__test = { getSettings };
