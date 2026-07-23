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
const { isSpeakableText, planNarration, splitNarrationSentences } = require('./tts-text');
const { getParagraphPauseMs } = require('./tts-engine-profile');
const {
  normalizeTtsOutputFormat,
  outputExtensionForFormat,
  outputFormatFromVariantKey
} = require('./tts-output-format');

/**
 * Default chunk size in characters (~2-3 min of spoken audio).
 */
const DEFAULT_CHUNK_SIZE = 4000;

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
    this.variantKeyProvider = options.variantKeyProvider || (() => 'default');
    this.outputFormatProvider = typeof options.outputFormatProvider === 'function'
      ? options.outputFormatProvider
      : (() => 'mp3');
    this.onChapterConcatenated = typeof options.onChapterConcatenated === 'function' ? options.onChapterConcatenated : null;
    this.textTransform = typeof options.textTransform === 'function' ? options.textTransform : null;
    this.generationJournal = options.generationJournal || null;
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
      this.queue.on('error', (evt) => this._onJobError(evt));
      this.queue.on('progress', (evt) => this._onJobProgress(evt));
    }

    /**
     * Maps jobId → { manifestKey, chunkIndex }
     * @type {Map<string, {manifestKey: string, chunkIndex: number}>}
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
    const plan = planNarration(text, { maxChars });
    const chunks = plan.chunks.map(chunk => ({
      text: chunk.text,
      paragraphFinal: chunk.paragraphFinal,
      pauseIntent: chunk.segments[chunk.segments.length - 1]?.pauseIntent || 'sentence',
      segments: chunk.segments.map(segment => ({ ...segment }))
    }));
    return this._coalesceUnspeakableChunks(chunks);
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
      .map(name => fsp.unlink(path.join(this.cacheDir, name)).catch(() => {})));
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
  async _buildManifest(bookId, chapterIndex, chunkTexts) {
    const key = this._manifestKey(bookId, chapterIndex);

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
    const chunks = await Promise.all(chunkTexts.map(async (chunkText, i) => {
      const p = this.chunkPath(bookId, chapterIndex, i);
      const exists = await this._fileExists(p);

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
      variantKey: String(this.variantKeyProvider() || 'default'),
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
    const chunkTexts = this.splitIntoChunksWithMeta(narrationText, this.getActiveChunkSize()).map(chunk => chunk.text);
    if (chunkTexts.length === 0) throw new Error('Chapter has no speakable text for TTS');
    return this._buildManifest(bookId, chapterIndex, chunkTexts);
  }

  /**
   * Generate (or resume generation for) a full chapter.
   *
   * 1. Splits text into chunks.
   * 2. Creates / refreshes the manifest (detects cached chunks).
   * 3. Enqueues first non-ready chunk as `priority`, remaining as 'next'.
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
    this._deletedBooks.delete(bookId);

    const narrationText = await this._narrationText(text, bookId, chapterIndex, language);

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
        voice: options.voice || null,
        chunkSize: this.getActiveChunkSize()
      });
    }
    const manifest = await this._buildManifest(bookId, chapterIndex, chunkTexts);
    const paragraphPauseMs = getParagraphPauseMs();
    const key = this._manifestKey(bookId, chapterIndex);

    let isFirst = true;

    for (let i = 0; i < manifest.chunks.length; i++) {
      const chunk = manifest.chunks[i];

      // Skip chunks already cached on disk
      if (chunk.status === STATUS.READY) continue;

      const chunkPriority = typeof options.priorityForChunk === 'function'
        ? options.priorityForChunk(i, isFirst)
        : (isFirst ? priority : 'next');
      isFirst = false;

      const outputPath = this.chunkPath(bookId, chapterIndex, i);

      const jobId = await this.queue.enqueue({
        text: chunkTexts[i],
        outputPath,
        language,
        priority: chunkPriority,
        voice: options.voice || null,
        padEndMs: chunkMeta[i].pauseIntent === 'heading'
          ? Math.max(paragraphPauseMs, 500)
          : (chunkMeta[i].paragraphFinal ? paragraphPauseMs : 0),
        narration: {
          pauseIntent: chunkMeta[i].pauseIntent,
          segments: chunkMeta[i].segments
        }
      });

      chunk.status = STATUS.QUEUED;
      chunk.jobId = jobId;

      // Track this job so we can update the manifest when it completes
      this._jobMap.set(jobId, { manifestKey: key, chunkIndex: i });
    }

    if (manifest.chunks.every(chunk => chunk.status === STATUS.READY)) {
      await this._clearGenerationIntent(manifest);
    }

    return manifest;
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
          { voice: entry.voice }
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
      variantKeyProvider: () => entry.variantKey,
      outputFormatProvider: this.outputFormatProvider,
      textTransform: this.textTransform,
      onChapterConcatenated: this.onChapterConcatenated,
      generationJournal: this.generationJournal,
      validateRecoveryEntry: this.validateRecoveryEntry
    });
    this._recoveryWorkers.set(entry.variantKey, worker);
    return worker;
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
    if (this._isDeletedManifestKey(mapping.manifestKey)) return;

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
    if (this._isDeletedManifestKey(mapping.manifestKey)) {
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
      }
    }

    this._jobMap.delete(evt.jobId);
  }

  /** @private */
  _onJobError(evt) {
    const mapping = this._jobMap.get(evt.jobId);
    if (!mapping) return;
    if (this._isDeletedManifestKey(mapping.manifestKey)) {
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

    const chunk = manifest.chunks[mapping.chunkIndex];
    if (chunk) {
      chunk.status = STATUS.ERROR;
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
    // and could concat the other voice's chunks.
    const listPath = this._concatListPath(bookId, chapterIndex, { clean: true });
    const partPath = `${outputPath}.part.m4a`;
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
      const singlePart = `${outputPath}.part.${this.outputExtension()}`;
      await fsp.copyFile(manifest.chunks[0].path, singlePart);
      await fsp.rename(singlePart, outputPath);
      await this._notifyChapterConcatenated(bookId, chapterIndex, outputPath);
      return outputPath;
    }

    // Variant-scoped list path: without _variantSegment() two voices
    // concatenating the same chapter concurrently would share one list file
    // and could concat the other voice's chunks.
    const listPath = this._concatListPath(bookId, chapterIndex);
    const partPath = `${outputPath}.part.${this.outputExtension()}`;
    const listContent = manifest.chunks
      .map(c => `file '${c.path.replace(/'/g, "'\\''")}'`)
      .join('\n');

    await fsp.writeFile(listPath, listContent, 'utf8');

    try {
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-y',                     // overwrite output
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c', 'copy',            // stream-copy (no re-encode)
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
    if (chunk.status !== STATUS.QUEUED || !chunk.jobId) return false;

    return this.queue.prioritize(chunk.jobId, priority);
  }

  cancelBook(bookId) {
    if (!this.queue) return 0;

    this._deletedBooks.add(bookId);
    let cancelled = 0;
    for (const [key, manifest] of this.manifests.entries()) {
      if (manifest.bookId !== bookId) continue;

      for (const chunk of manifest.chunks || []) {
        if (chunk.jobId && this.queue.cancel(chunk.jobId)) {
          cancelled++;
        }
      }
      this.manifests.delete(key);
    }

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
    const waits = [];
    for (const chunk of manifest.chunks || []) {
      if (chunk.index < fromChunkIndex || !chunk.jobId) continue;
      this.queue.cancel(chunk.jobId);
      waits.push(this.queue.waitFor(chunk.jobId).catch(() => {}));
    }
    await Promise.all(waits);
    this.manifests.delete(this._manifestKey(bookId, chapterIndex));
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
