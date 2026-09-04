/**
 * Chunked TTS - Smart text splitting and chunk-based TTS generation
 * 
 * Splits chapter text into ~4000-char chunks at natural boundaries
 * (paragraphs first, then sentences), tracks per-chapter manifests,
 * and integrates with TTSQueue for prioritised generation.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { isSpeakableText, splitNarrationSentences } = require('./tts-text');
const {
  HYBRID_SPLIT_POLICY,
  LEGACY_SPLIT_POLICY,
  normalizeSplitPolicy,
  planNarrationForPolicy
} = require('./tts-split-policy');
const { CHAPTER_PAUSE_MS, getParagraphPauseMs } = require('./tts-engine-profile');
const {
  normalizeTtsOutputFormat,
  outputExtensionForFormat,
  outputFormatFromVariantKey
} = require('./tts-output-format');
const { MASTERING_POLICY, getMasteringBitrate } = require('./audio-quality');

/**
 * Default chunk size in characters (~2-3 min of spoken audio).
 */
const DEFAULT_CHUNK_SIZE = 4000;
const DEFAULT_MATERIALIZED_CHUNKS = 3;
const PRIORITY_ORDER = Object.freeze({
  immediate: 0,
  next: 1,
  lookahead: 2,
  download: 3,
  background: 4
});

function normalizeChunkIndexes(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(index => Number.isInteger(index) && index >= 0))]
    .sort((left, right) => left - right);
}

function generationClaimKey(claim = {}) {
  return [claim.origin, claim.requestId, claim.sessionId]
    .map(value => value || '')
    .join('\u0000');
}

function throwIfGenerationAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Generation intent was retired');
  error.name = 'AbortError';
  throw error;
}

/**
 * Chunk status constants.
 */
const STATUS = Object.freeze({
  PENDING:    'pending',
  QUEUED:     'queued',
  GENERATING: 'generating',
  READY:      'ready',
  ERROR:      'error'
});

function assertSafePathComponent(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPermanentGenerationError(error) {
  const status = Number(error?.status || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return /\((?:400|401|403|404|405|409|410|415|422)\)/.test(message) ||
    /unsupported audio type|no speakable text|invalid (?:bookid|chapterindex|language|voice)|authentication failed/.test(message);
}

function voiceFromVariantKey(variantKey) {
  const value = String(variantKey || '');
  const local = value.match(/^((?:kokoro|chatterbox):[^:]+)/);
  if (local) return local[1];
  const edge = value.match(/^([^:]+):chunk\d+(?=:|$)/);
  return edge ? edge[1] : null;
}

class ChunkedTTS extends EventEmitter {
  /**
   * @param {string} cacheDir - Directory for chunk & chapter audio files
   * @param {import('./tts-queue')|null} ttsQueue - TTSQueue instance (optional; required for generation)
   * @param {object} [options]
   * @param {number} [options.chunkSize=4000] - Max characters per chunk
   * @param {() => number} [options.chunkSizeProvider] - Dynamic max characters per chunk
   */
  constructor(cacheDir, ttsQueue = null, options = {}) {
    super();
    this.cacheDir = cacheDir;
    this.queue = ttsQueue;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    this.chunkSizeProvider = options.chunkSizeProvider || null;
    this.splitPolicyProvider = options.splitPolicyProvider || (() => LEGACY_SPLIT_POLICY);
    this.maxMaterializedChunks = Number.isInteger(options.maxMaterializedChunks) &&
      options.maxMaterializedChunks > 0
      ? options.maxMaterializedChunks
      : DEFAULT_MATERIALIZED_CHUNKS;
    this._schedulerId = options.schedulerId || crypto.randomBytes(8).toString('hex');
    this.variantKeyProvider = options.variantKeyProvider || (() => 'default');
    this.outputFormatProvider = typeof options.outputFormatProvider === 'function'
      ? options.outputFormatProvider
      : (() => 'mp3');
    this.voiceProvider = typeof options.voiceProvider === 'function'
      ? options.voiceProvider
      : null;
    this.onChapterConcatenated = typeof options.onChapterConcatenated === 'function' ? options.onChapterConcatenated : null;
    this.textTransform = typeof options.textTransform === 'function' ? options.textTransform : null;
    this.generationJournal = options.generationJournal || null;
    // How often waitForChapter() re-checks that the work it is waiting on still
    // exists, and how many times it will try to revive a stranded chapter
    // before giving up. See waitForChapter().
    this.chapterLivenessIntervalMs = Number(options.chapterLivenessIntervalMs) > 0
      ? Number(options.chapterLivenessIntervalMs)
      : 15000;
    this.chapterLivenessRecoveries = Number.isInteger(options.chapterLivenessRecoveries)
      && options.chapterLivenessRecoveries >= 0
      ? options.chapterLivenessRecoveries
      : 4;
    // How often reconcile() re-derives scheduling state from the manifests and
    // the queue. 0 disables the loop; reconcile() stays callable by hand.
    this.reconcileIntervalMs = Number.isFinite(Number(options.reconcileIntervalMs))
      && Number(options.reconcileIntervalMs) >= 0
      ? Number(options.reconcileIntervalMs)
      : 20000;
    this._reconcileTimer = null;
    this._reconcileInFlight = false;
    this.validateRecoveryEntry = typeof options.validateRecoveryEntry === 'function'
      ? options.validateRecoveryEntry
      : null;

    /**
     * In-memory manifest store.
     * Key: "{bookId}_{chapterIndex}" → manifest object
     * @type {Map<string, object>}
     */
    this.manifests = new Map();

    // When the queue completes or errors a job, update the manifest
    if (this.queue) {
      this.queue.on('complete', (evt) => this._onJobComplete(evt));
      this.queue.on('job-error', (evt) => this._onJobError(evt));
      this.queue.on('progress', (evt) => this._onJobProgress(evt));
      this.queue.on('settled', () => this._resumeCapacityWaiters());
    }

    /**
     * Maps jobId → { manifestKey, chunkIndex }
     * @type {Map<string, {manifestKey: string, chunkIndex: number, bookId: string}>}
     */
    this._jobMap = new Map();
    this._deletedBooks = new Set();
    this._recoveryWorkers = new Map();
    this._failedManifests = new WeakSet();
  }

  // ---------------------------------------------------------------------------
  // Text splitting
  // ---------------------------------------------------------------------------

  /**
   * Split text into chunks of at most `maxChars` characters.
   *
   * Strategy:
   *   1. Split by paragraph boundaries (double newline).
   *   2. Group paragraphs into chunks up to maxChars.
   *   3. If a single paragraph exceeds maxChars, split it at sentence boundaries.
   *   4. Never split mid-sentence (if a single sentence exceeds maxChars it becomes
   *      its own chunk — we do NOT break words).
   *
   * @param {string} text
   * @param {number} [maxChars]
   * @returns {string[]}
   */
  splitIntoChunks(text, maxChars = this.chunkSize) {
    return this.splitIntoChunksWithMeta(text, maxChars).map(c => c.text);
  }

  /**
   * Like splitIntoChunks, but each chunk carries `paragraphFinal` — true when
   * the chunk's last piece ended a source paragraph. Used to append a
   * deterministic paragraph pause to that chunk's audio. Paragraph boundaries
   * *inside* a packed chunk rely on the engine's own treatment of `\n\n`;
   * only chunk-final boundaries get the deterministic pause.
   *
   * @param {string} text
   * @param {number} [maxChars]
   * @returns {{text: string, paragraphFinal: boolean}[]}
   */
  splitIntoChunksWithMeta(text, maxChars = this.chunkSize) {
    const splitPolicy = this.getActiveSplitPolicy();
    const plan = planNarrationForPolicy(text, {
      policy: splitPolicy,
      firstMaxChars: splitPolicy === HYBRID_SPLIT_POLICY
        ? Math.min(420, maxChars)
        : maxChars,
      targetChars: 750,
      maxChars: 900,
      minChars: 200
    });
    const chunks = plan.chunks.map(chunk => ({
      text: chunk.text,
      paragraphFinal: chunk.paragraphFinal,
      pauseIntent: chunk.segments[chunk.segments.length - 1]?.pauseIntent || 'sentence',
      segments: chunk.segments.map(segment => ({ ...segment }))
    }));
    return this._coalesceUnspeakableChunks(chunks);
  }

  getActiveSplitPolicy() {
    return normalizeSplitPolicy(this.splitPolicyProvider());
  }

  _coalesceUnspeakableChunks(chunks) {
    const output = [];
    let pendingPrefix = [];

    for (const chunk of chunks) {
      if (isSpeakableText(chunk.text)) {
        output.push({
          ...chunk,
          text: pendingPrefix.length
            ? `${pendingPrefix.map(prefix => prefix.text).join('\n\n')}\n\n${chunk.text}`
            : chunk.text,
          segments: pendingPrefix.length
            ? pendingPrefix.flatMap(prefix => prefix.segments || []).concat(chunk.segments || [])
            : chunk.segments
        });
        pendingPrefix = [];
      } else {
        pendingPrefix.push(chunk);
      }
    }

    if (pendingPrefix.length && output.length) {
      const last = output[output.length - 1];
      output[output.length - 1] = {
        ...last,
        text: `${last.text}\n\n${pendingPrefix.map(suffix => suffix.text).join('\n\n')}`,
        paragraphFinal: true,
        pauseIntent: pendingPrefix[pendingPrefix.length - 1]?.pauseIntent || 'paragraph',
        segments: (last.segments || []).concat(pendingPrefix.flatMap(suffix => suffix.segments || []))
      };
    }

    return output.filter(chunk => isSpeakableText(chunk.text));
  }

  getActiveChunkSize() {
    if (!this.chunkSizeProvider) return this.chunkSize;
    const provided = Number(this.chunkSizeProvider());
    if (!Number.isFinite(provided) || provided <= 0) return this.chunkSize;
    return Math.round(provided);
  }

  /**
   * Split a block of text into individual sentences.
   * Handles common abbreviations, decimal numbers, and quoted speech.
   *
   * @param {string} text
   * @returns {string[]}
   */
  _splitSentences(text) {
    return splitNarrationSentences(text);
  }

  // ---------------------------------------------------------------------------
  // Chunk file naming
  // ---------------------------------------------------------------------------

  currentOutputFormat() {
    const variantFormat = outputFormatFromVariantKey(this.variantKeyProvider());
    if (variantFormat) return variantFormat;
    return normalizeTtsOutputFormat(this.outputFormatProvider());
  }

  outputExtension(rawFormat = this.currentOutputFormat()) {
    return outputExtensionForFormat(rawFormat);
  }

  /**
   * Get the file path for a specific chunk.
   * @param {string} bookId
   * @param {number} chapterIndex
   * @param {number} chunkIndex
   * @returns {string}
   */
  chunkPath(bookId, chapterIndex, chunkIndex) {
    return this.chunkPathForVariant(bookId, chapterIndex, chunkIndex, this.variantKeyProvider(), this.currentOutputFormat());
  }

  chunkPathForVariant(bookId, chapterIndex, chunkIndex, rawVariant, outputFormat = null) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    assertNonNegativeInteger(chunkIndex, 'chunkIndex');
    const format = outputFormat || outputFormatFromVariantKey(rawVariant) || this.currentOutputFormat();
    return path.join(this.cacheDir, `${bookId}${this.variantSegment(rawVariant)}_ch${chapterIndex}_chunk${chunkIndex}.${this.outputExtension(format)}`);
  }

  /**
   * Get the file path for a concatenated chapter.
   * @param {string} bookId
   * @param {number} chapterIndex
   * @returns {string}
   */
  chapterPath(bookId, chapterIndex) {
    return this.chapterPathForVariant(bookId, chapterIndex, this.variantKeyProvider(), this.currentOutputFormat());
  }

  chapterPathForVariant(bookId, chapterIndex, rawVariant, outputFormat = null) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    const format = outputFormat || outputFormatFromVariantKey(rawVariant) || this.currentOutputFormat();
    return path.join(this.cacheDir, `${bookId}${this.variantSegment(rawVariant)}_ch${chapterIndex}.${this.outputExtension(format)}`);
  }

  /**
   * Path of the ffmpeg concat list file for a chapter. Variant-scoped:
   * two voices concatenating the same chapter concurrently must not share
   * a list file, or one can concat the other voice's chunks.
   */
  _concatListPath(bookId, chapterIndex, { clean = false } = {}) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    const suffix = clean ? '_concat_clean.txt' : '_concat.txt';
    return path.join(this.cacheDir, `${bookId}${this._variantSegment()}_ch${chapterIndex}${suffix}`);
  }

  /**
   * Sidecar file recording the chunk-text hash the chapter's cached audio
   * was generated from. Variant-scoped like the audio itself.
   */
  _chapterHashPath(bookId, chapterIndex) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    return path.join(this.cacheDir, `${bookId}${this._variantSegment()}_ch${chapterIndex}.texthash`);
  }

  /**
   * Delete all cached audio artifacts for one chapter (current variant):
   * chunks, stitched chapter files, and concat list files.
   */
  async _deleteChapterAudio(bookId, chapterIndex) {
    const variantSegment = this._variantSegment();
    const escapedBookId = escapeRegExp(bookId);
    const escapedVariant = escapeRegExp(variantSegment);
    const chunkPattern = new RegExp(`^${escapedBookId}${escapedVariant}_ch${chapterIndex}_chunk\\d+\\.(?:mp3|wav)$`);
    const entries = await fsp.readdir(this.cacheDir).catch(() => []);
    await Promise.all(entries
      .filter(name => chunkPattern.test(name))
      .map(async name => {
        const outputPath = path.join(this.cacheDir, name);
        await this.queue?.invalidateRenderedOutput?.({ bookId, chapterIndex, outputPath });
        await Promise.all([
          fsp.unlink(outputPath).catch(() => {}),
          fsp.unlink(`${outputPath}.narration-artifact.json`).catch(() => {})
        ]);
      }));
    await fsp.unlink(this.chapterPath(bookId, chapterIndex)).catch(() => {});
    await fsp.unlink(this.cleanChapterPath(bookId, chapterIndex)).catch(() => {});
    await fsp.unlink(this._concatListPath(bookId, chapterIndex)).catch(() => {});
    await fsp.unlink(this._concatListPath(bookId, chapterIndex, { clean: true })).catch(() => {});
  }

  /**
   * Manifest key for a book + chapter.
   */
  _manifestKey(bookId, chapterIndex) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    return `${bookId}${this._variantSegment()}_${chapterIndex}`;
  }

  variantSegment(rawVariant) {
    const value = String(rawVariant || 'default');
    if (value === 'default') return '';
    return `_tts${crypto.createHash('sha1').update(value).digest('hex').slice(0, 10)}`;
  }

  _variantSegment() {
    return this.variantSegment(this.variantKeyProvider());
  }

  currentVariantSegment() {
    return this._variantSegment();
  }

  // ---------------------------------------------------------------------------
  // Cache awareness
  // ---------------------------------------------------------------------------

  /**
   * Check whether a file exists on disk.
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async _fileExists(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  async _cachedChunkDurationSeconds(chunk) {
    const explicit = Number(chunk?.duration);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (chunk?.status !== STATUS.READY) return null;

    const filePath = chunk.path || this.chunkPath(
      chunk.bookId,
      chunk.chapterIndex,
      chunk.index
    );
    try {
      const stat = await fsp.stat(filePath);
      const format = path.extname(filePath).slice(1).toLowerCase();
      if (format === 'wav') {
        const bytesPerSecond = MASTERING_POLICY.sampleRate * MASTERING_POLICY.channels * 2;
        return Math.max(0, stat.size - 44) / bytesPerSecond;
      }
      const match = String(getMasteringBitrate()).match(/^(\d+)k$/);
      const bitsPerSecond = (Number(match?.[1]) || 160) * 1000;
      return stat.size * 8 / bitsPerSecond;
    } catch {
      return null;
    }
  }

  /**
   * Plan a chapter-relative seek without decoding every earlier chunk.
   * Existing CBR MP3/WAV files provide measured duration anchors; unrendered
   * chunks inherit the observed seconds-per-character rate, falling back to
   * the extractor estimate only when no rendered anchor exists yet.
   */
  async planChapterSeek(bookId, chapterIndex, requestedSeconds, fallbackDurationSeconds = 0) {
    const manifest = this.getChapterManifest(bookId, chapterIndex);
    if (!manifest?.chunks?.length) {
      return {
        targetChunk: 0,
        chunkOffsetSeconds: Math.max(0, Number(requestedSeconds) || 0),
        chunkStartSeconds: 0,
        logicalOffsetSeconds: Math.max(0, Number(requestedSeconds) || 0),
        estimatedTotalDuration: Math.max(0, Number(fallbackDurationSeconds) || 0)
      };
    }

    const measured = await Promise.all(manifest.chunks.map(chunk => (
      this._cachedChunkDurationSeconds({
        ...chunk,
        bookId,
        chapterIndex
      })
    )));
    let measuredSeconds = 0;
    let measuredCharacters = 0;
    for (let index = 0; index < manifest.chunks.length; index++) {
      if (!Number.isFinite(measured[index]) || measured[index] <= 0) continue;
      measuredSeconds += measured[index];
      measuredCharacters += Math.max(1, Number(manifest.chunks[index].textLength) || 0);
    }
    const fallbackDuration = Math.max(0, Number(fallbackDurationSeconds) || 0);
    const fallbackRate = fallbackDuration > 0 && manifest.textLength > 0
      ? fallbackDuration / manifest.textLength
      : 0;
    const secondsPerCharacter = measuredSeconds > 0 && measuredCharacters > 0
      ? measuredSeconds / measuredCharacters
      : fallbackRate;
    const durations = manifest.chunks.map((chunk, index) => {
      if (Number.isFinite(measured[index]) && measured[index] > 0) return measured[index];
      const textLength = Math.max(1, Number(chunk.textLength) || 0);
      return Math.max(0.25, secondsPerCharacter > 0 ? textLength * secondsPerCharacter : 10);
    });
    const estimatedTotalDuration = durations.reduce((sum, duration) => sum + duration, 0);
    const requested = Math.max(0, Number(requestedSeconds) || 0);
    const logicalOffsetSeconds = Math.min(
      requested,
      Math.max(0, estimatedTotalDuration - 0.05)
    );

    let chunkStartSeconds = 0;
    let targetChunk = durations.length - 1;
    for (let index = 0; index < durations.length; index++) {
      if (logicalOffsetSeconds < chunkStartSeconds + durations[index]) {
        targetChunk = index;
        break;
      }
      chunkStartSeconds += durations[index];
    }
    const targetDuration = durations[targetChunk] || 0;
    const chunkOffsetSeconds = Math.min(
      Math.max(0, logicalOffsetSeconds - chunkStartSeconds),
      Math.max(0, targetDuration - 0.05)
    );
    return {
      targetChunk,
      chunkOffsetSeconds,
      chunkStartSeconds,
      logicalOffsetSeconds,
      estimatedTotalDuration
    };
  }

  // ---------------------------------------------------------------------------
  // Manifest management
  // ---------------------------------------------------------------------------

  /**
   * Get (or create) a chapter manifest.
   *
   * @param {string} bookId
   * @param {number} chapterIndex
   * @returns {object|null} The manifest, or null if none exists
   */
  getChapterManifest(bookId, chapterIndex) {
    const key = this._manifestKey(bookId, chapterIndex);
    return this.manifests.get(key) || null;
  }

  /**
   * List chapters whose cached manifest contains failed chunks — the
   * engine-resume watcher's work list.
   *
   * @returns {{bookId: string, chapterIndex: number}[]}
   */
  listChaptersWithErrors() {
    const out = [];
    for (const manifest of this.manifests.values()) {
      if (manifest.chunks.some(chunk => chunk.status === STATUS.ERROR)) {
        out.push({ bookId: manifest.bookId, chapterIndex: manifest.chapterIndex });
      }
    }
    return out;
  }

  manifestNeedsResume(manifest) {
    if (!manifest) return false;
    if (manifest._generation && !manifest._generation.halted && !manifest._generation.cancelled) {
      return manifest.chunks.some(chunk => {
        if (chunk.status === STATUS.ERROR) return true;
        if (chunk.status !== STATUS.QUEUED && chunk.status !== STATUS.GENERATING) return false;
        if (!chunk.jobId || !this.queue || typeof this.queue.getStatus !== 'function') return true;
        const jobStatus = this.queue.getStatus(chunk.jobId);
        return !jobStatus || !['queued', 'generating'].includes(jobStatus.status);
      });
    }
    return manifest.chunks.some(chunk => {
      if (chunk.status === STATUS.READY) return false;
      if (chunk.status === STATUS.PENDING || chunk.status === STATUS.ERROR) return true;
      if (chunk.status !== STATUS.QUEUED && chunk.status !== STATUS.GENERATING) return false;
      if (!chunk.jobId || !this.queue || typeof this.queue.getStatus !== 'function') return true;
      const jobStatus = this.queue.getStatus(chunk.jobId);
      return !jobStatus || jobStatus.status === 'complete' || jobStatus.status === 'error' || jobStatus.status === 'cancelled';
    });
  }

  /**
   * Build a fresh manifest for a chapter, checking cache on disk.
   *
   * @param {string} bookId
   * @param {number} chapterIndex
   * @param {string[]} chunkTexts - The split chunk texts
   * @returns {Promise<object>}
   */
  async _buildManifest(bookId, chapterIndex, chunkMetaOrTexts, options = {}) {
    const key = this._manifestKey(bookId, chapterIndex);
    const chunkMeta = chunkMetaOrTexts.map(value => typeof value === 'string'
      ? { text: value, paragraphFinal: false, pauseIntent: null, segments: [] }
      : value);
    const chunkTexts = chunkMeta.map(chunk => chunk.text);

    // Guard against stale audio: cached chunk files are matched positionally
    // by filename, so if the chapter text changed (e.g. extraction fixes,
    // CHAPTER_CACHE_VERSION bump) old audio must be discarded, not reused.
    // A sidecar file records the text hash the on-disk audio was built from.
    // Legacy caches without a sidecar are grandfathered as valid.
    const textHash = crypto.createHash('sha1')
      .update(chunkTexts.join('\u0000'))
      .digest('hex')
      .slice(0, 12);
    const hashPath = this._chapterHashPath(bookId, chapterIndex);
    let storedHash = null;
    try {
      storedHash = (await fsp.readFile(hashPath, 'utf8')).trim();
    } catch {}
    if (storedHash && storedHash !== textHash) {
      await this._deleteChapterAudio(bookId, chapterIndex);
    }
    if (storedHash !== textHash) {
      await fsp.writeFile(hashPath, textHash).catch(() => {});
    }

    const textLength = chunkTexts.reduce((sum, t) => sum + t.length, 0);
    const variantKey = String(this.variantKeyProvider() || 'default');
    const voice = options.voice || this.voiceProvider?.() || voiceFromVariantKey(variantKey);
    const chunks = await Promise.all(chunkTexts.map(async (chunkText, i) => {
      const p = this.chunkPath(bookId, chapterIndex, i);
      let exists = await this._fileExists(p);
      if (this.queue?.reuseRenderedOutput) {
        const render = this._chunkRenderOptions(chunkMeta[i], i, chunkTexts.length);
        exists = await this.queue.reuseRenderedOutput({
          text: chunkText,
          outputPath: p,
          language: options.language || 'en',
          voice,
          padEndMs: render.padEndMs,
          narration: render.narration,
          activity: { bookId, chapterIndex, chunkIndex: i, variantKey }
        }) || exists;
      }

      return {
        index: i,
        status: exists ? STATUS.READY : STATUS.PENDING,
        path: exists ? p : null,
        textLength: chunkText.length,
        duration: null,
        jobId: null
      };
    }));

    const manifest = {
      bookId,
      chapterIndex,
      variantKey,
      totalChunks: chunkTexts.length,
      chunks,
      textLength,
      estimatedTotalDuration: null
    };

    this.manifests.set(key, manifest);
    return manifest;
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  async _narrationText(text, bookId, chapterIndex, language) {
    if (!this.textTransform) return text;
    const transformed = await this.textTransform({ text, bookId, chapterIndex, language });
    if (typeof transformed !== 'string') {
      throw new Error('ChunkedTTS textTransform must return a string');
    }
    return transformed;
  }

  /** Reconstruct status from durable text hashes and audio files without enqueueing work. */
  async reconstructChapterManifest(bookId, chapterIndex, text, language = 'en') {
    const narrationText = await this._narrationText(text, bookId, chapterIndex, language);
    const chunkMeta = this.splitIntoChunksWithMeta(narrationText, this.getActiveChunkSize());
    if (chunkMeta.length === 0) throw new Error('Chapter has no speakable text for TTS');
    return this._buildManifest(bookId, chapterIndex, chunkMeta, { language });
  }

  async chapterArtifactReusePlan(bookId, chapterIndex, text, language = 'en', options = {}) {
    if (!this.queue?.renderedOutputFingerprint) return null;
    const narrationText = await this._narrationText(text, bookId, chapterIndex, language);
    const chunkMeta = this.splitIntoChunksWithMeta(narrationText, this.getActiveChunkSize());
    if (chunkMeta.length === 0) return null;
    const chunkTexts = chunkMeta.map(chunk => chunk.text);
    const textHash = crypto.createHash('sha1').update(chunkTexts.join('\u0000')).digest('hex').slice(0, 12);
    const variantKey = String(this.variantKeyProvider() || 'default');
    const voice = options.voice || this.voiceProvider?.() || voiceFromVariantKey(variantKey);
    const artifacts = chunkMeta.map((chunk, index) => {
      const render = this._chunkRenderOptions(chunk, index, chunkMeta.length);
      const outputPath = this.chunkPath(bookId, chapterIndex, index);
      return {
        outputPath,
        fingerprint: this.queue.renderedOutputFingerprint({
          text: chunk.text,
          outputPath,
          language,
          voice,
          padEndMs: render.padEndMs,
          narration: render.narration,
          activity: { bookId, chapterIndex, chunkIndex: index, variantKey }
        })
      };
    }).filter(item => item.fingerprint);
    return { artifacts, textHash, hashPath: this._chapterHashPath(bookId, chapterIndex) };
  }

  async indexChapterArtifacts(bookId, chapterIndex, text, language = 'en', options = {}) {
    if (!this.queue?.indexRenderedOutput) return 0;
    const narrationText = await this._narrationText(text, bookId, chapterIndex, language);
    const chunkMeta = this.splitIntoChunksWithMeta(narrationText, this.getActiveChunkSize());
    if (chunkMeta.length === 0) return 0;
    const chunkTexts = chunkMeta.map(chunk => chunk.text);
    const textHash = crypto.createHash('sha1')
      .update(chunkTexts.join('\u0000'))
      .digest('hex')
      .slice(0, 12);
    let storedHash = null;
    try {
      storedHash = (await fsp.readFile(this._chapterHashPath(bookId, chapterIndex), 'utf8')).trim();
    } catch {}
    // Backfill only artifacts whose exact current chapter identity is proven.
    // The normal manifest path still grandfathers legacy files, but indexing a
    // legacy file into a cross-version cache needs a stronger guarantee.
    if (storedHash !== textHash) return 0;

    const variantKey = String(this.variantKeyProvider() || 'default');
    const voice = options.voice || this.voiceProvider?.() || voiceFromVariantKey(variantKey);
    let indexed = 0;
    for (let index = 0; index < chunkMeta.length; index++) {
      const render = this._chunkRenderOptions(chunkMeta[index], index, chunkMeta.length);
      const outputPath = this.chunkPath(bookId, chapterIndex, index);
      if (await this.queue.indexRenderedOutput({
        text: chunkMeta[index].text,
        outputPath,
        language,
        voice,
        padEndMs: render.padEndMs,
        narration: render.narration,
        activity: { bookId, chapterIndex, chunkIndex: index, variantKey }
      })) indexed++;
    }
    return indexed;
  }

  async invalidateCachedChunk(bookId, chapterIndex, chunkIndex) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    assertNonNegativeInteger(chunkIndex, 'chunkIndex');
    const filePath = this.chunkPath(bookId, chapterIndex, chunkIndex);
    await this.queue?.invalidateRenderedOutput?.({ bookId, chapterIndex, outputPath: filePath });
    await fsp.unlink(filePath).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await fsp.unlink(`${filePath}.narration-artifact.json`).catch(() => {});
    const chunk = this.getChapterManifest(bookId, chapterIndex)?.chunks?.[chunkIndex];
    if (chunk) {
      chunk.status = STATUS.PENDING;
      chunk.path = null;
      chunk.duration = null;
      chunk.jobId = null;
    }
    return filePath;
  }

  /**
   * Generate (or resume generation for) a full chapter.
   *
   * 1. Splits text into chunks.
   * 2. Creates / refreshes the manifest (detects cached chunks).
   * 3. Enqueues download work at download priority; playback keeps its
   *    first-chunk/next-chunk priority policy.
   * 4. Returns the manifest immediately.
   *
   * @param {string} bookId
   * @param {number} chapterIndex
   * @param {string} text - Full chapter text
   * @param {string} [language='en']
   * @param {string} [priority='immediate'] - Priority for the first pending chunk
   * @param {object} [options]
   * @param {string} [options.voice] - Voice snapshot to render every chunk in this generation pass
   * @returns {Promise<object>} The chapter manifest
   */
  async generateChapter(bookId, chapterIndex, text, language = 'en', priority = 'immediate', options = {}) {
    if (!this.queue) {
      throw new Error('ChunkedTTS requires a TTSQueue instance for generation');
    }
    throwIfGenerationAborted(options.signal);
    this._deletedBooks.delete(bookId);

    const narrationText = await this._narrationText(text, bookId, chapterIndex, language);
    throwIfGenerationAborted(options.signal);

    const chunkMeta = this.splitIntoChunksWithMeta(narrationText, this.getActiveChunkSize());
    const chunkTexts = chunkMeta.map(c => c.text);
    if (chunkTexts.length === 0) {
      throw new Error('Chapter has no speakable text for TTS');
    }
    const variantKey = String(this.variantKeyProvider() || 'default');
    if (this.generationJournal) {
      await this.generationJournal.putChapter({
        bookId,
        chapterIndex,
        variantKey,
        text,
        language,
        priority,
        origin: options.origin || null,
        requestId: options.requestId || null,
        sessionId: options.sessionId || null,
        chunkIndexes: normalizeChunkIndexes(options.chunkIndexes),
        voice: options.voice || null,
        chunkSize: this.getActiveChunkSize(),
        splitPolicy: this.getActiveSplitPolicy()
      });
    }
    throwIfGenerationAborted(options.signal);
    const manifest = await this._buildManifest(bookId, chapterIndex, chunkMeta, {
      language,
      voice: options.voice || null
    });
    throwIfGenerationAborted(options.signal);
    this._installGenerationPlan(manifest, {
      chunkMeta,
      chunkTexts,
      language,
      priority,
      priorityForChunk: options.priorityForChunk,
      voice: options.voice || null,
      origin: options.origin || null,
      requestId: options.requestId || null,
      sessionId: options.sessionId || null,
      chunkIndexes: normalizeChunkIndexes(options.chunkIndexes),
      claims: options.claims
    });
    await this._pumpManifest(manifest, options.signal);

    if (manifest.chunks.every(chunk => chunk.status === STATUS.READY)) {
      await this._clearGenerationIntent(manifest);
    }

    return manifest;
  }

  _installGenerationPlan(manifest, options) {
    const initialClaim = {
      priority: options.priority,
      origin: options.origin,
      requestId: options.requestId,
      sessionId: options.sessionId,
      chunkIndexes: options.chunkIndexes
    };
    const recoveredClaims = Array.isArray(options.claims) && options.claims.length > 0;
    const claims = (recoveredClaims
      ? options.claims
      : [initialClaim]).map(claim => ({
        priority: typeof claim.priority === 'string' ? claim.priority : options.priority,
        origin: claim.origin || null,
        requestId: claim.requestId || null,
        sessionId: claim.sessionId || null,
        chunkIndexes: normalizeChunkIndexes(claim.chunkIndexes),
        affectsPriority: recoveredClaims
      }));
    const plan = {
      chunkMeta: options.chunkMeta,
      chunkTexts: options.chunkTexts,
      language: options.language,
      voice: options.voice,
      priority: options.priority,
      priorityForChunk: typeof options.priorityForChunk === 'function'
        ? options.priorityForChunk
        : null,
      baseActivity: Array.isArray(options.chunkIndexes)
        ? { origin: null, requestId: null, sessionId: null }
        : {
            origin: options.origin,
            requestId: options.requestId,
            sessionId: options.sessionId
          },
      claims,
      priorityOverrides: new Map(),
      halted: false,
      cancelled: false
    };
    Object.defineProperty(manifest, '_generation', {
      value: plan,
      writable: true,
      configurable: true,
      enumerable: false
    });
    // Armed on first real work rather than in the constructor, so an instance
    // that never generates anything never holds a timer.
    this._startReconcileLoop();
  }

  _chunkRenderOptions(meta, chunkIndex, totalChunks) {
    const paragraphPauseMs = getParagraphPauseMs();
    const isFinalChunk = chunkIndex === totalChunks - 1;
    return {
      padEndMs: isFinalChunk
        ? CHAPTER_PAUSE_MS
        : meta?.pauseIntent === 'heading'
          ? Math.max(paragraphPauseMs, 500)
          : (meta?.paragraphFinal ? paragraphPauseMs : 0),
      narration: {
        pauseIntent: meta?.pauseIntent || null,
        segments: Array.isArray(meta?.segments) ? meta.segments : []
      }
    };
  }

  _claimAppliesToChunk(claim, chunkIndex) {
    return !Array.isArray(claim.chunkIndexes) || claim.chunkIndexes.includes(chunkIndex);
  }

  _priorityForManifestChunk(manifest, chunkIndex) {
    const plan = manifest._generation;
    if (!plan) return 'background';
    const priorities = [];
    const override = plan.priorityOverrides.get(chunkIndex);
    if (override) priorities.push(override);
    const firstPendingIndex = manifest.chunks.find(chunk => chunk.status !== STATUS.READY)?.index;
    if (plan.priorityForChunk) {
      priorities.push(plan.priorityForChunk(chunkIndex, chunkIndex === firstPendingIndex));
    } else if (['download', 'lookahead', 'background'].includes(plan.priority)) {
      priorities.push(plan.priority);
    } else {
      priorities.push(chunkIndex === firstPendingIndex ? plan.priority : 'next');
    }
    for (const claim of plan.claims) {
      if (claim.affectsPriority && this._claimAppliesToChunk(claim, chunkIndex)) {
        priorities.push(claim.priority);
      }
    }
    return priorities.filter(Boolean).sort((left, right) =>
      (PRIORITY_ORDER[left] ?? PRIORITY_ORDER.background) -
      (PRIORITY_ORDER[right] ?? PRIORITY_ORDER.background)
    )[0] || 'background';
  }

  _claimsForManifestChunk(manifest, chunkIndex) {
    return (manifest._generation?.claims || [])
      .filter(claim => this._claimAppliesToChunk(claim, chunkIndex))
      .sort((left, right) =>
        (PRIORITY_ORDER[left.priority] ?? PRIORITY_ORDER.background) -
        (PRIORITY_ORDER[right.priority] ?? PRIORITY_ORDER.background)
      );
  }

  _candidateChunkIndexes(manifest) {
    return manifest.chunks
      .filter(chunk => chunk.status !== STATUS.READY && chunk.status !== STATUS.ERROR)
      .map(chunk => ({
        index: chunk.index,
        priority: this._priorityForManifestChunk(manifest, chunk.index)
      }))
      .sort((left, right) =>
        (PRIORITY_ORDER[left.priority] ?? PRIORITY_ORDER.background) -
          (PRIORITY_ORDER[right.priority] ?? PRIORITY_ORDER.background) ||
        left.index - right.index
      )
      .map(candidate => candidate.index);
  }

  _liveManifestChunks(manifest) {
    return manifest.chunks.filter(chunk =>
      chunk.status === STATUS.QUEUED || chunk.status === STATUS.GENERATING
    );
  }

  _rebalanceMaterializedChunks(manifest, desiredIndexes) {
    const desired = new Set(desiredIndexes.slice(0, this.maxMaterializedChunks));
    const desiredPending = desiredIndexes
      .slice(0, this.maxMaterializedChunks)
      .filter(index => manifest.chunks[index]?.status === STATUS.PENDING);
    if (desiredPending.length === 0) return;

    const cancellable = this._liveManifestChunks(manifest)
      .filter(chunk => chunk.status === STATUS.QUEUED && !desired.has(chunk.index))
      .sort((left, right) =>
        (PRIORITY_ORDER[this._priorityForManifestChunk(manifest, right.index)] ?? PRIORITY_ORDER.background) -
          (PRIORITY_ORDER[this._priorityForManifestChunk(manifest, left.index)] ?? PRIORITY_ORDER.background) ||
        right.index - left.index
      );
    for (const chunk of cancellable) {
      const jobId = chunk.jobId;
      const queueClaims = this.queue.getActivityClaims?.(jobId) || [];
      if (queueClaims.some(claim => claim.schedulerId !== this._schedulerId)) continue;
      if (!jobId || !this.queue.cancel(jobId)) continue;
      this._jobMap.delete(jobId);
      chunk.status = STATUS.PENDING;
      chunk.jobId = null;
    }
  }

  _pumpManifest(manifest, signal = null) {
    const previous = manifest._pumpPromise || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this._pumpManifestNow(manifest, signal))
      .catch(error => {
        this._failManifestScheduling(manifest, error);
        throw error;
      });
    Object.defineProperty(manifest, '_pumpPromise', {
      value: next,
      writable: true,
      configurable: true,
      enumerable: false
    });
    next.finally(() => {
      if (manifest._pumpPromise === next) manifest._pumpPromise = null;
    }).catch(() => {});
    return next;
  }

  _failManifestScheduling(manifest, error) {
    if (!manifest || error?.name === 'AbortError') return;
    if (manifest._generation) manifest._generation.halted = true;
    const chunk = manifest.chunks.find(candidate => candidate.status === STATUS.PENDING);
    if (chunk) {
      chunk.status = STATUS.ERROR;
      chunk.jobId = null;
    }
    this._recordManifestFailure(manifest, error);
    this.emit('scheduler:error', {
      bookId: manifest.bookId,
      chapterIndex: manifest.chapterIndex,
      error
    });
    this.emit('chunk:error', {
      bookId: manifest.bookId,
      chapterIndex: manifest.chapterIndex,
      chunkIndex: chunk?.index ?? null,
      error
    });
  }

  /**
   * Promote a chunk to READY when its artifact is already rendered.
   *
   * Chunk paths are content-addressed — book, chapter, index, variant and
   * output format are all in the filename — and _buildManifest deletes the
   * chapter's audio outright when the source text hash changes. A file at the
   * expected path is therefore the correct audio for this chunk, and
   * regenerating it would be pure duplicate work.
   *
   * @returns {Promise<boolean>} whether the chunk was adopted
   */
  async _adoptRenderedChunk(manifest, chunk) {
    if (!chunk || chunk.status === STATUS.READY) return false;
    const chunkPath = chunk.path || this.chunkPath(manifest.bookId, manifest.chapterIndex, chunk.index);
    if (!(await this._fileExists(chunkPath))) return false;
    chunk.status = STATUS.READY;
    chunk.path = chunkPath;
    chunk.jobId = null;
    this.emit('chunk:ready', {
      bookId: manifest.bookId,
      chapterIndex: manifest.chapterIndex,
      chunkIndex: chunk.index,
      path: chunkPath,
      adopted: true
    });
    return true;
  }

  /**
   * Announce chapter completion when every chunk is ready. _onJobComplete does
   * this for the chunk that finished last; adoption needs the same settlement,
   * or a chapter completed off the event path would leave its waiters hanging.
   */
  _settleManifestIfComplete(manifest) {
    if (!manifest.chunks.every(chunk => chunk.status === STATUS.READY)) return false;
    this._clearGenerationIntent(manifest).catch(error => {
      this.emit('journal:error', {
        bookId: manifest.bookId,
        chapterIndex: manifest.chapterIndex,
        error
      });
    });
    this.emit('chapter:ready', {
      bookId: manifest.bookId,
      chapterIndex: manifest.chapterIndex
    });
    return true;
  }

  async _pumpManifestNow(manifest, signal = null) {
    const plan = manifest._generation;
    if (!plan || plan.halted || plan.cancelled || this._deletedBooks.has(manifest.bookId)) return;
    throwIfGenerationAborted(signal);
    plan.waitingForCapacity = false;

    let adopted = false;
    for (const chunk of this._liveManifestChunks(manifest)) {
      const jobStatus = chunk.jobId && this.queue.getStatus?.(chunk.jobId);
      if (jobStatus && ['queued', 'generating'].includes(jobStatus.status)) continue;
      this._jobMap.delete(chunk.jobId);
      chunk.status = STATUS.PENDING;
      chunk.jobId = null;
      // The job is gone, but that does not mean the work is. It may have
      // finished and had its completion dropped — _onJobComplete ignores an
      // event whose _jobMap entry this loop already removed — or its queue
      // record may simply have aged out of the finished-job cache. Resetting
      // to PENDING without looking would re-synthesize audio that is already
      // sitting on disk. Disk is the source of truth here, exactly as it is
      // when the manifest is first built.
      adopted = (await this._adoptRenderedChunk(manifest, chunk)) || adopted;
    }
    // Adoption can be what finishes a chapter — every remaining chunk turning
    // out to be rendered already. Settle it here or its waiters never hear.
    if (adopted && this._settleManifestIfComplete(manifest)) return;

    const candidates = this._candidateChunkIndexes(manifest);
    this._rebalanceMaterializedChunks(manifest, candidates);
    let capacity = this.maxMaterializedChunks - this._liveManifestChunks(manifest).length;
    for (const chunkIndex of candidates) {
      if (capacity <= 0) break;
      throwIfGenerationAborted(signal);
      const chunk = manifest.chunks[chunkIndex];
      if (!chunk || chunk.status !== STATUS.PENDING) continue;
      try {
        await this._materializeChunk(manifest, chunkIndex);
      } catch (error) {
        if (error?.code === 'TTS_MATERIALIZATION_LIMIT') {
          plan.waitingForCapacity = true;
          break;
        }
        throw error;
      }
      capacity--;
    }
  }

  /**
   * Close the gap between what each manifest still needs and what the queue is
   * actually holding.
   *
   * Generation is otherwise driven purely by edges — a `complete`, `error` or
   * `settled` event, matched back to a manifest through _jobMap. Every one of
   * those edges can be missed: _onJobComplete drops an event whose _jobMap
   * entry a concurrent pump already removed, a cancelled job fires nothing that
   * re-pumps its manifest, and a job whose queue record has aged out of the
   * finished-job cache reports no status at all. Miss the last edge for a
   * chapter and it stops dead with PENDING chunks, no jobs, and nothing that
   * will ever look at it again — production sat idle for 56 minutes mid-listen
   * exactly this way, while chapter status still answered `preparing: true`.
   *
   * So state is re-derived rather than remembered. This runs on a timer, is
   * safe to run at any moment, and does nothing when everything is healthy.
   *
   * @returns {Promise<string[]>} manifest keys that needed intervention
   */
  async reconcile() {
    const repaired = [];
    for (const [key, manifest] of [...this.manifests]) {
      const plan = manifest._generation;
      if (!plan || plan.halted || plan.cancelled) continue;
      if (this._deletedBooks.has(manifest.bookId) || this._isDeletedManifestKey(key)) continue;
      const outstanding = manifest.chunks.some(chunk =>
        chunk.status !== STATUS.READY && chunk.status !== STATUS.ERROR
      );
      if (!outstanding) continue;
      // Live work means the queue is on it; leave it be.
      if (this._chapterHasLiveQueueWork(manifest)) continue;
      repaired.push(key);
      // _pumpManifestNow adopts already-rendered chunks, resets orphaned ones
      // and re-materializes, so a single pump is the whole repair.
      await this._pumpManifest(manifest).catch(() => {});
      this._settleManifestIfComplete(manifest);
    }
    if (repaired.length) {
      this.emit('scheduler:reconciled', { manifestKeys: repaired });
    }
    return repaired;
  }

  /**
   * Run reconcile() on a timer. Unref'd: this is background repair and must
   * never be the reason a process stays alive.
   */
  _startReconcileLoop() {
    if (this._reconcileTimer || !(this.reconcileIntervalMs > 0)) return;
    this._reconcileTimer = setInterval(() => {
      if (this._reconcileInFlight) return;
      this._reconcileInFlight = true;
      void this.reconcile()
        .catch(error => this.emit('scheduler:error', { error }))
        .finally(() => { this._reconcileInFlight = false; });
    }, this.reconcileIntervalMs);
    this._reconcileTimer.unref?.();
  }

  stopReconcileLoop() {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    for (const worker of this._recoveryWorkers.values()) worker.stopReconcileLoop();
  }

  _resumeCapacityWaiters() {
    for (const manifest of this.manifests.values()) {
      if (!manifest._generation?.waitingForCapacity) continue;
      this._pumpManifest(manifest).catch(() => {});
    }
  }

  async _materializeChunk(manifest, chunkIndex) {
    const plan = manifest._generation;
    const chunk = manifest.chunks[chunkIndex];
    if (!plan || !chunk || chunk.status !== STATUS.PENDING) return false;
    const priority = this._priorityForManifestChunk(manifest, chunkIndex);
    const claims = this._claimsForManifestChunk(manifest, chunkIndex);
    const primaryClaim = claims[0] || {
      priority,
      ...plan.baseActivity
    };
    const meta = plan.chunkMeta[chunkIndex];
    const render = this._chunkRenderOptions(meta, chunkIndex, manifest.totalChunks);
    const variantKey = manifest.variantKey || String(this.variantKeyProvider() || 'default');
    const activity = {
      bookId: manifest.bookId,
      chapterIndex: manifest.chapterIndex,
      chunkIndex,
      variantKey,
      origin: primaryClaim.origin || null,
      requestId: primaryClaim.requestId || null,
      sessionId: primaryClaim.sessionId || null,
      schedulerId: this._schedulerId
    };
    const jobId = await this.queue.enqueue({
      text: plan.chunkTexts[chunkIndex],
      outputPath: this.chunkPath(manifest.bookId, manifest.chapterIndex, chunkIndex),
      language: plan.language,
      priority,
      voice: plan.voice,
      activity,
      materializationLimit: this.maxMaterializedChunks,
      // Chunk paths carry book, chapter, index, variant and format, and stale
      // audio is deleted wholesale when the source text hash changes, so a
      // file already at this path is this chunk's audio.
      reuseExistingOutput: true,
      padEndMs: render.padEndMs,
      narration: render.narration
    });
    chunk.status = STATUS.QUEUED;
    chunk.jobId = jobId;
    this._jobMap.set(jobId, {
      manifestKey: this._manifestKey(manifest.bookId, manifest.chapterIndex),
      chunkIndex,
      bookId: manifest.bookId
    });
    for (const claim of claims.slice(1)) {
      this.queue.claim?.(jobId, {
        bookId: manifest.bookId,
        chapterIndex: manifest.chapterIndex,
        chunkIndex,
        variantKey,
        origin: claim.origin || null,
        requestId: claim.requestId || null,
        sessionId: claim.sessionId || null,
        schedulerId: this._schedulerId
      }, claim.priority);
    }
    return true;
  }

  /**
   * Whether the queue is holding real work for any unfinished chunk of this
   * chapter right now.
   *
   * This is deliberately not manifestNeedsResume(): that answers "should a
   * *restart* re-enqueue this", and it reports a chapter whose chunks are all
   * PENDING — enqueued nowhere, owned by nobody — as fine. A chapter in that
   * state is stranded, which is what left production reporting
   * `preparing: true` for an hour against an empty queue.
   */
  _chapterHasLiveQueueWork(manifest) {
    // Without a queue there is nothing to verify, so assume the caller's own
    // machinery is driving generation.
    if (!this.queue || typeof this.queue.getStatus !== 'function') return true;
    // A chapter parked on materialization capacity holds no job by design; the
    // 'settled' handler revives it. Only call it stranded once the queue has
    // gone idle underneath it, because then no settle event is ever coming.
    if (manifest._generation?.waitingForCapacity) {
      const status = this.queue.getQueueStatus?.();
      if (!status || Number(status.active) > 0 || Number(status.queued) > 0) return true;
    }
    return manifest.chunks.some(chunk => {
      if (chunk.status === STATUS.READY || !chunk.jobId) return false;
      const jobStatus = this.queue.getStatus(chunk.jobId);
      return Boolean(jobStatus) && ['queued', 'generating'].includes(jobStatus.status);
    });
  }

  waitForChapter(bookId, chapterIndex, options = {}) {
    const manifest = this.getChapterManifest(bookId, chapterIndex);
    if (!manifest) return Promise.reject(new Error(`No manifest for book ${bookId} chapter ${chapterIndex}`));
    if (manifest.chunks.every(chunk => chunk.status === STATUS.READY)) return Promise.resolve(manifest);
    const failed = manifest.chunks.find(chunk => chunk.status === STATUS.ERROR);
    if (failed) return Promise.reject(new Error(`Chapter generation failed at chunk ${failed.index}`));

    return new Promise((resolve, reject) => {
      let livenessTimer = null;
      const cleanup = () => {
        if (livenessTimer !== null) clearInterval(livenessTimer);
        livenessTimer = null;
        this.off('chapter:ready', onReady);
        this.off('chunk:error', onError);
        this.off('chapter:cancelled', onChapterCancelled);
        this.off('book:cancelled', onCancelled);
        options.signal?.removeEventListener('abort', onAborted);
      };
      const onReady = event => {
        if (event.bookId !== bookId || event.chapterIndex !== chapterIndex) return;
        cleanup();
        resolve(manifest);
      };
      const onError = event => {
        if (event.bookId !== bookId || event.chapterIndex !== chapterIndex) return;
        cleanup();
        reject(event.error || new Error(`Chapter generation failed at chunk ${event.chunkIndex}`));
      };
      const onCancelled = event => {
        if (event.bookId !== bookId) return;
        cleanup();
        reject(new Error('Chapter generation cancelled'));
      };
      const onChapterCancelled = event => {
        if (event.bookId !== bookId || event.chapterIndex !== chapterIndex) return;
        cleanup();
        reject(new Error('Chapter generation cancelled'));
      };
      const onAborted = () => {
        cleanup();
        const error = new Error('Generation intent was retired');
        error.name = 'AbortError';
        reject(error);
      };
      // Every settlement above is an event. If the work this is waiting on
      // disappears without emitting one — a chunk that was never enqueued, a
      // job dropped between schedulers, a capacity waiter with nothing left to
      // settle it — the promise waits forever, and every caller above it does
      // too: the prepare job stays in the map, chapter-audio-status keeps
      // answering `preparing: true`, and clients poll a chapter nothing is
      // generating. So re-derive liveness from the manifest and the queue
      // rather than trusting that an event will arrive.
      let strandedChecks = 0;
      const checkLiveness = () => {
        const current = this.getChapterManifest(bookId, chapterIndex);
        if (!current) {
          cleanup();
          reject(new Error(`No manifest for book ${bookId} chapter ${chapterIndex}`));
          return;
        }
        // A missed event is itself one of the failure modes; settle on state.
        if (current.chunks.every(chunk => chunk.status === STATUS.READY)) {
          cleanup();
          resolve(current);
          return;
        }
        const failedChunk = current.chunks.find(chunk => chunk.status === STATUS.ERROR);
        if (failedChunk) {
          cleanup();
          reject(new Error(`Chapter generation failed at chunk ${failedChunk.index}`));
          return;
        }
        if (this._chapterHasLiveQueueWork(current)) {
          strandedChecks = 0;
          return;
        }
        strandedChecks += 1;
        if (strandedChecks <= this.chapterLivenessRecoveries) {
          // Re-pump: this resets chunks whose jobs are gone back to PENDING and
          // materializes them again. Recovering beats failing, since the text
          // and any finished chunks are still on disk.
          this._pumpManifest(current).catch(() => {});
          return;
        }
        cleanup();
        const error = new Error(
          `Chapter generation stalled with no scheduled work for book ${bookId} chapter ${chapterIndex}`
        );
        error.code = 'CHAPTER_GENERATION_STRANDED';
        reject(error);
      };

      this.on('chapter:ready', onReady);
      this.on('chunk:error', onError);
      this.on('chapter:cancelled', onChapterCancelled);
      this.on('book:cancelled', onCancelled);
      options.signal?.addEventListener('abort', onAborted, { once: true });
      if (options.signal?.aborted) return onAborted();
      // Deliberately not unref'd. This timer is the only thing standing between
      // a stranded chapter and an unsettled promise, so it must be able to hold
      // the loop open long enough to reject. It is always cleared on settle,
      // and the stranded path settles after a bounded number of checks.
      if (this.chapterLivenessIntervalMs > 0) {
        livenessTimer = setInterval(checkLiveness, this.chapterLivenessIntervalMs);
      }
    });
  }

  /**
   * Resume ordinary chapter intents after a process restart. Callers may use
   * the returned report to surface entries for another voice variant instead
   * of accidentally rendering them into the current variant's cache.
   */
  async resumePendingChapters({ recoverAllVariants = false } = {}) {
    if (!this.generationJournal) return { resumed: [], skipped: [], failed: [] };
    const entries = await this.generationJournal.listChapters();
    const currentVariant = String(this.variantKeyProvider() || 'default');
    const report = { resumed: [], skipped: [], failed: [] };
    for (const entry of entries) {
      if (!recoverAllVariants && entry.variantKey !== currentVariant) {
        report.skipped.push(entry);
        continue;
      }
      try {
        if (this.validateRecoveryEntry) {
          try {
            const validation = await this.validateRecoveryEntry(entry);
            if (validation === false || validation?.compatible === false) {
              throw new Error(validation?.error || 'Chapter recovery variant is incompatible with the current provider');
            }
          } catch (error) {
            error.code = 'INCOMPATIBLE_RECOVERY_VARIANT';
            throw error;
          }
        }
        const worker = entry.variantKey === currentVariant
          ? this
          : this._recoveryWorker(entry);
        const manifest = await worker.generateChapter(
          entry.bookId,
          entry.chapterIndex,
          entry.text,
          entry.language,
          entry.priority,
          {
            voice: entry.voice,
            origin: entry.origin,
            requestId: entry.requestId,
            sessionId: entry.sessionId,
            chunkIndexes: entry.chunkIndexes,
            claims: entry.claims
          }
        );
        report.resumed.push({ entry, manifest });
      } catch (error) {
        if (error.code === 'INCOMPATIBLE_RECOVERY_VARIANT') {
          await this.generationJournal.recordChapterFailure(
            entry.bookId,
            entry.chapterIndex,
            entry.variantKey,
            { error, permanent: true }
          );
          this.emit('recovery:error', { entry, error });
        }
        report.failed.push({ entry, error });
      }
    }
    return report;
  }

  _recoveryWorker(entry) {
    let worker = this._recoveryWorkers.get(entry.variantKey);
    if (worker) return worker;
    worker = new ChunkedTTS(this.cacheDir, this.queue, {
      chunkSize: Number.isFinite(entry.chunkSize) && entry.chunkSize > 0
        ? entry.chunkSize
        : this.getActiveChunkSize(),
      splitPolicyProvider: () => entry.splitPolicy || (
        String(entry.variantKey || '').includes(':splithybrid1') ? 'hybrid-v1' : 'legacy-v1'
      ),
      variantKeyProvider: () => entry.variantKey,
      outputFormatProvider: this.outputFormatProvider,
      voiceProvider: () => entry.voice || voiceFromVariantKey(entry.variantKey),
      textTransform: this.textTransform,
      onChapterConcatenated: this.onChapterConcatenated,
      generationJournal: this.generationJournal,
      validateRecoveryEntry: this.validateRecoveryEntry,
      // Variant workers own their own manifests, and premium or recovery
      // preparation is exactly the long-running background work no waiter is
      // watching — the case that most needs reconciling.
      reconcileIntervalMs: this.reconcileIntervalMs
    });
    this._recoveryWorkers.set(entry.variantKey, worker);
    return worker;
  }

  workerForVariant(variantKey, { voice = null, chunkSize = null } = {}) {
    if (typeof variantKey !== 'string' || !variantKey) {
      throw new TypeError('variantKey is required');
    }
    return this._recoveryWorker({
      variantKey,
      voice,
      chunkSize: Number.isFinite(chunkSize) && chunkSize > 0
        ? chunkSize
        : this.getActiveChunkSize()
    });
  }

  _clearGenerationIntent(manifest) {
    if (!this.generationJournal || !manifest) return Promise.resolve();
    return this.generationJournal.removeChapter(
      manifest.bookId,
      manifest.chapterIndex,
      manifest.variantKey || String(this.variantKeyProvider() || 'default')
    );
  }

  // ---------------------------------------------------------------------------
  // Queue event handlers
  // ---------------------------------------------------------------------------

  /** @private */
  _onJobProgress(evt) {
    const mapping = this._jobMap.get(evt.jobId);
    if (!mapping) return;
    if (this._deletedBooks.has(mapping.bookId) || this._isDeletedManifestKey(mapping.manifestKey)) {
      this._jobMap.delete(evt.jobId);
      return;
    }

    const manifest = this.manifests.get(mapping.manifestKey);
    if (!manifest) return;
    if (this._deletedBooks.has(manifest.bookId)) return;

    const chunk = manifest.chunks[mapping.chunkIndex];
    if (chunk && evt.status === 'generating') {
      chunk.status = STATUS.GENERATING;
      this.emit('chunk:generating', {
        bookId: manifest.bookId,
        chapterIndex: manifest.chapterIndex,
        chunkIndex: mapping.chunkIndex
      });
    }
  }

  /** @private */
  _onJobComplete(evt) {
    const mapping = this._jobMap.get(evt.jobId);
    if (!mapping) return;
    if (this._deletedBooks.has(mapping.bookId) || this._isDeletedManifestKey(mapping.manifestKey)) {
      this._jobMap.delete(evt.jobId);
      if (evt.outputPath) {
        fsp.unlink(evt.outputPath).catch(() => {});
      }
      return;
    }

    const manifest = this.manifests.get(mapping.manifestKey);
    if (!manifest) return;
    if (this._deletedBooks.has(manifest.bookId)) {
      this._jobMap.delete(evt.jobId);
      if (evt.outputPath) {
        fsp.unlink(evt.outputPath).catch(() => {});
      }
      return;
    }

    const chunk = manifest.chunks[mapping.chunkIndex];
    if (chunk) {
      chunk.status = STATUS.READY;
      chunk.path = evt.outputPath;
      chunk.jobId = null;

      this.emit('chunk:ready', {
        bookId: manifest.bookId,
        chapterIndex: manifest.chapterIndex,
        chunkIndex: mapping.chunkIndex,
        path: evt.outputPath
      });

      // Check if all chunks are now ready
      if (manifest.chunks.every(c => c.status === STATUS.READY)) {
        this._clearGenerationIntent(manifest).catch(error => {
          this.emit('journal:error', { bookId: manifest.bookId, chapterIndex: manifest.chapterIndex, error });
        });
        this.emit('chapter:ready', {
          bookId: manifest.bookId,
          chapterIndex: manifest.chapterIndex
        });
      } else {
        this._pumpManifest(manifest).catch(() => {});
      }
    }

    this._jobMap.delete(evt.jobId);
  }

  /** @private */
  _onJobError(evt) {
    const mapping = this._jobMap.get(evt.jobId);
    if (!mapping) return;
    if (this._deletedBooks.has(mapping.bookId) || this._isDeletedManifestKey(mapping.manifestKey)) {
      this._jobMap.delete(evt.jobId);
      return;
    }

    const manifest = this.manifests.get(mapping.manifestKey);
    if (!manifest) return;
    if (this._deletedBooks.has(manifest.bookId)) {
      this._jobMap.delete(evt.jobId);
      return;
    }

    this._recordManifestFailure(manifest, evt.error);
    if (manifest._generation) manifest._generation.halted = true;

    const chunk = manifest.chunks[mapping.chunkIndex];
    if (chunk) {
      chunk.status = STATUS.ERROR;
      chunk.jobId = null;
      this.emit('chunk:error', {
        bookId: manifest.bookId,
        chapterIndex: manifest.chapterIndex,
        chunkIndex: mapping.chunkIndex,
        error: evt.error
      });
    }

    this._jobMap.delete(evt.jobId);
  }

  _recordManifestFailure(manifest, error) {
    if (!this.generationJournal || !manifest || this._failedManifests.has(manifest)) return;
    this._failedManifests.add(manifest);
    this.generationJournal.recordChapterFailure(
      manifest.bookId,
      manifest.chapterIndex,
      manifest.variantKey || String(this.variantKeyProvider() || 'default'),
      { error, permanent: isPermanentGenerationError(error) }
    ).catch(journalError => {
      this.emit('journal:error', {
        bookId: manifest.bookId,
        chapterIndex: manifest.chapterIndex,
        error: journalError
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Concatenation
  // ---------------------------------------------------------------------------


  cleanChapterPath(bookId, chapterIndex) {
    assertSafePathComponent(bookId, 'bookId');
    assertNonNegativeInteger(chapterIndex, 'chapterIndex');
    return path.join(this.cacheDir, `${bookId}${this._variantSegment()}_ch${chapterIndex}.m4a`);
  }

  async concatenateChunksClean(bookId, chapterIndex) {
    const manifest = this.getChapterManifest(bookId, chapterIndex);
    if (!manifest) throw new Error(`No manifest for book ${bookId} chapter ${chapterIndex}`);

    const notReady = manifest.chunks.filter(c => c.status !== STATUS.READY);
    if (notReady.length > 0) {
      throw new Error(`Cannot concatenate: ${notReady.length} chunk(s) not ready (indices: ${notReady.map(c => c.index).join(', ')})`);
    }

    const outputPath = this.cleanChapterPath(bookId, chapterIndex);
    // Variant-scoped list path: without _variantSegment() two voices
    // concatenating the same chapter concurrently would share one list file
    // and could concat the other voice's chunks. Per-invocation unique suffix
    // so two concurrent concats of the same chapter+variant cannot share
    // list/part files (Sol agree #2).
    const runId = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const listPath = `${this._concatListPath(bookId, chapterIndex, { clean: true })}.${runId}.tmp`;
    const partPath = `${outputPath}.${runId}.part.m4a`;
    const listContent = manifest.chunks
      .map(c => `file '${c.path.replace(/'/g, "'\\''")}'`)
      .join('\n');

    await fsp.writeFile(listPath, listContent, 'utf8');
    try {
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'concat', '-safe', '0', '-i', listPath,
          '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k',
          '-f', 'mp4',
          partPath
        ], (err, _stdout, stderr) => {
          if (err) reject(new Error(`ffmpeg clean concat failed: ${err.message}\n${stderr}`));
          else resolve();
        });
      });
      await fsp.rename(partPath, outputPath);
    } finally {
      await fsp.unlink(listPath).catch(() => {});
      await fsp.unlink(partPath).catch(() => {});
    }
    await this._notifyChapterConcatenated(bookId, chapterIndex, outputPath);
    return outputPath;
  }

  /**
   * Concatenate all chunks for a chapter into a single audio file using ffmpeg.
   *
   * @param {string} bookId
   * @param {number} chapterIndex
   * @returns {Promise<string>} Path to the concatenated chapter audio
   */
  async concatenateChunks(bookId, chapterIndex) {
    const manifest = this.getChapterManifest(bookId, chapterIndex);

    if (!manifest) {
      throw new Error(`No manifest for book ${bookId} chapter ${chapterIndex}`);
    }

    // Verify all chunks are ready
    const notReady = manifest.chunks.filter(c => c.status !== STATUS.READY);
    if (notReady.length > 0) {
      throw new Error(
        `Cannot concatenate: ${notReady.length} chunk(s) not ready ` +
        `(indices: ${notReady.map(c => c.index).join(', ')})`
      );
    }

    const outputPath = this.chapterPath(bookId, chapterIndex);

    // If there's only one chunk, just copy it (via temp + rename so a crash
    // mid-copy can't leave a truncated chapter file).
    if (manifest.chunks.length === 1) {
      const singleId = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      const singlePart = `${outputPath}.${singleId}.part.${this.outputExtension()}`;
      await fsp.copyFile(manifest.chunks[0].path, singlePart);
      await fsp.rename(singlePart, outputPath);
      await this._notifyChapterConcatenated(bookId, chapterIndex, outputPath);
      return outputPath;
    }

    // Variant-scoped list path: without _variantSegment() two voices
    // concatenating the same chapter concurrently would share one list file
    // and could concat the other voice's chunks. Per-invocation unique suffix
    // so concurrent concats of the same chapter+variant cannot collide.
    const concatRunId = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const listPath = `${this._concatListPath(bookId, chapterIndex)}.${concatRunId}.tmp`;
    const partPath = `${outputPath}.${concatRunId}.part.${this.outputExtension()}`;
    const listContent = manifest.chunks
      .map(c => `file '${c.path.replace(/'/g, "'\\''")}'`)
      .join('\n');

    await fsp.writeFile(listPath, listContent, 'utf8');

    try {
      await new Promise((resolve, reject) => {
        const encodeArgs = this.currentOutputFormat() === 'wav'
          ? ['-c:a', 'pcm_s16le', '-f', 'wav']
          : ['-c:a', 'libmp3lame', '-b:a', getMasteringBitrate(), '-f', 'mp3'];
        execFile('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',                     // overwrite output
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-map_metadata', '-1',
          '-vn',
          '-ac', String(MASTERING_POLICY.channels),
          '-ar', String(MASTERING_POLICY.sampleRate),
          ...encodeArgs,
          partPath
        ], (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`ffmpeg concat failed: ${err.message}\n${stderr}`));
          } else {
            resolve();
          }
        });
      });
      await fsp.rename(partPath, outputPath);
    } finally {
      // Clean up concat list and any leftover partial output
      await fsp.unlink(listPath).catch(() => {});
      await fsp.unlink(partPath).catch(() => {});
    }

    await this._notifyChapterConcatenated(bookId, chapterIndex, outputPath);
    return outputPath;
  }

  async _notifyChapterConcatenated(bookId, chapterIndex, outputPath) {
    if (!this.onChapterConcatenated) return;
    try {
      await this.onChapterConcatenated({ bookId, chapterIndex, outputPath });
    } catch (err) {
      console.warn(`Chapter duration recording failed for ${bookId}:${chapterIndex}:`, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Utility / legacy helpers
  // ---------------------------------------------------------------------------


  prioritizeChunk(bookId, chapterIndex, chunkIndex, priority = 'immediate') {
    if (!this.queue) return false;

    const manifest = this.getChapterManifest(bookId, chapterIndex);
    if (!manifest || !manifest.chunks[chunkIndex]) return false;

    const chunk = manifest.chunks[chunkIndex];
    if ((chunk.status === STATUS.QUEUED || chunk.status === STATUS.GENERATING) && chunk.jobId) {
      return this.queue.prioritize(chunk.jobId, priority);
    }
    if (chunk.status !== STATUS.PENDING || !manifest._generation) return false;
    manifest._generation.priorityOverrides.set(chunkIndex, priority);
    this._pumpManifest(manifest).catch(() => {});
    return true;
  }

  async claimChapter(bookId, chapterIndex, activity, priority = 'background', options = {}) {
    if (!this.queue || typeof this.queue.claim !== 'function') return 0;
    throwIfGenerationAborted(options.signal);
    const manifest = this.getChapterManifest(bookId, chapterIndex);
    if (!manifest) return 0;
    const variantKey = manifest.variantKey || String(this.variantKeyProvider() || 'default');
    const chunkIndexes = normalizeChunkIndexes(options.chunkIndexes);
    const durableClaim = {
      ...activity,
      bookId,
      chapterIndex,
      variantKey,
      priority,
      chunkIndexes
    };
    const journalChanged = await this.generationJournal?.addChapterClaim?.(durableClaim);
    try {
      throwIfGenerationAborted(options.signal);
    } catch (error) {
      if (journalChanged) await this.generationJournal?.removeChapterClaim?.(durableClaim);
      throw error;
    }
    let claimed = 0;
    try {
      const planClaim = {
        priority,
        origin: activity?.origin || null,
        requestId: activity?.requestId || null,
        sessionId: activity?.sessionId || null,
        chunkIndexes,
        affectsPriority: true
      };
      if (manifest._generation) {
        const claimKey = generationClaimKey(planClaim);
        manifest._generation.claims = manifest._generation.claims
          .filter(claim => generationClaimKey(claim) !== claimKey);
        manifest._generation.claims.push(planClaim);
      }
      const selectedChunks = (manifest.chunks || []).filter(chunk =>
        !Array.isArray(chunkIndexes) || chunkIndexes.includes(chunk.index)
      );
      for (const chunk of selectedChunks) {
        throwIfGenerationAborted(options.signal);
        if (!chunk.jobId) continue;
        if (this.queue.claim(chunk.jobId, {
          ...activity,
          bookId,
          chapterIndex,
          chunkIndex: chunk.index,
          variantKey,
          schedulerId: this._schedulerId
        }, priority)) {
          claimed += 1;
        }
      }
      if (manifest._generation) {
        await this._pumpManifest(manifest, options.signal);
        claimed = selectedChunks.filter(chunk =>
          chunk.status === STATUS.READY ||
          chunk.status === STATUS.QUEUED ||
          chunk.status === STATUS.GENERATING
        ).length;
      }
      return claimed;
    } catch (error) {
      if (claimed > 0 && typeof this.queue.cancelWhere === 'function') {
        this.queue.cancelWhere(candidate =>
          candidate.bookId === bookId &&
          candidate.chapterIndex === chapterIndex &&
          candidate.variantKey === variantKey &&
          candidate.origin === (activity?.origin || null) &&
          candidate.requestId === (activity?.requestId || null) &&
          candidate.sessionId === (activity?.sessionId || null) &&
          candidate.schedulerId === this._schedulerId &&
          candidate.priority === priority
        );
      }
      if (journalChanged) await this.generationJournal?.removeChapterClaim?.(durableClaim);
      throw error;
    }
  }

  cancelBook(bookId) {
    if (!this.queue) return 0;

    this._deletedBooks.add(bookId);
    let cancelled = 0;
    for (const worker of this._recoveryWorkers.values()) {
      cancelled += worker.cancelBook(bookId);
    }
    for (const [key, manifest] of this.manifests.entries()) {
      if (manifest.bookId !== bookId) continue;
      if (manifest._generation) manifest._generation.cancelled = true;

      for (const chunk of manifest.chunks || []) {
        if (chunk.jobId && this.queue.cancel(chunk.jobId)) {
          cancelled++;
        }
      }
      this.manifests.delete(key);
    }
    this.emit('book:cancelled', { bookId });

    this.generationJournal?.removeChaptersForBook(bookId).catch(error => {
      this.emit('journal:error', { bookId, error });
    });

    return cancelled;
  }

  /**
   * Stop queued work and wait for already-running work for one chapter before
   * an external cache invalidator removes affected files. This prevents stale
   * generation from recreating audio after a pronunciation repair.
   */
  async quiesceChapter(bookId, chapterIndex, fromChunkIndex = 0) {
    const manifest = this.getChapterManifest(bookId, chapterIndex);
    if (!manifest || !this.queue) return;
    if (manifest._generation) manifest._generation.cancelled = true;
    const waits = [];
    for (const chunk of manifest.chunks || []) {
      if (chunk.index < fromChunkIndex || !chunk.jobId) continue;
      this.queue.cancel(chunk.jobId);
      waits.push(this.queue.waitFor(chunk.jobId).catch(() => {}));
    }
    await Promise.all(waits);
    this.manifests.delete(this._manifestKey(bookId, chapterIndex));
    this.emit('chapter:cancelled', { bookId, chapterIndex });
  }

  async quiesceChapterAllVariants(bookId, chapterIndex, fromChunkIndexByVariant = {}, fallbackIndex = 0) {
    const boundaries = typeof fromChunkIndexByVariant === 'object' && fromChunkIndexByVariant !== null
      ? fromChunkIndexByVariant
      : { [this.currentVariantSegment()]: Number(fromChunkIndexByVariant) || 0 };
    const boundaryFor = worker => Object.hasOwn(boundaries, worker.currentVariantSegment())
      ? Math.max(0, Number(boundaries[worker.currentVariantSegment()]) || 0)
      : Math.max(0, Number(fallbackIndex) || 0);
    await Promise.all([
      this.quiesceChapter(bookId, chapterIndex, boundaryFor(this)),
      ...[...this._recoveryWorkers.values()].map(worker =>
        worker.quiesceChapter(bookId, chapterIndex, boundaryFor(worker))
      )
    ]);
  }

  _isDeletedManifestKey(manifestKey) {
    const sep = manifestKey.lastIndexOf('_');
    if (sep <= 0) return false;
    return this._deletedBooks.has(manifestKey.slice(0, sep));
  }

  /**
   * Discover all existing chunk files for a chapter on disk
   * (useful when no manifest is loaded yet).
   * @returns {Promise<string[]>} Array of chunk file paths that exist
   */
  async getChapterChunks(bookId, chapterIndex) {
    const chunks = [];
    let i = 0;
    while (true) {
      const p = this.chunkPath(bookId, chapterIndex, i);
      if (await this._fileExists(p)) {
        chunks.push(p);
        i++;
      } else {
        break;
      }
    }
    return chunks;
  }
}

module.exports = ChunkedTTS;
module.exports.STATUS = STATUS;
module.exports.DEFAULT_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
module.exports.assertSafePathComponent = assertSafePathComponent;
module.exports.getParagraphPauseMs = getParagraphPauseMs;
module.exports.isPermanentGenerationError = isPermanentGenerationError;
