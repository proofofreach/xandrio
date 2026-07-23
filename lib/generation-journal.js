/**
 * Durable journal for reconstructable generation work.
 *
 * The journal stores intent and ordering, never in-memory promises or claims
 * that audio exists. Recovery re-checks the audio cache before doing work.
 */
const jsonStore = require('./json-store');

class GenerationJournal {
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = filePath;
  }

  async list() {
    let jobs = [];
    await jsonStore.update(this.filePath, data => {
      if (!data.version) data.version = 1;
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      this._migratePremiumJobs(data.jobs);
      jobs = Object.values(data.jobs).filter(job =>
        job && typeof job.bookId === 'string' && typeof job.variantKey === 'string'
      );
    }, { version: 1, jobs: {}, chapterJobs: {} });
    return jobs;
  }

  async listQuarantinedPremium() {
    const data = await jsonStore.load(this.filePath, { version: 1, jobs: {}, quarantinedJobs: {} });
    return Object.values(data.quarantinedJobs || {}).filter(job =>
      job && typeof job.bookId === 'string' && typeof job.variantKey === 'string'
    );
  }

  quarantinePremium(record, error) {
    if (!record || typeof record.bookId !== 'string' || typeof record.variantKey !== 'string') {
      return Promise.resolve();
    }
    return jsonStore.update(this.filePath, data => {
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      if (!data.quarantinedJobs || typeof data.quarantinedJobs !== 'object') data.quarantinedJobs = {};
      this._migratePremiumJobs(data.jobs);
      const key = this._premiumKey(record.bookId, record.variantKey);
      data.quarantinedJobs[key] = {
        ...record,
        status: 'quarantined',
        lastError: String(error?.message || error || 'Incompatible recovery record').slice(0, 500),
        quarantinedAt: Date.now()
      };
      delete data.jobs[key];
    }, { version: 1, jobs: {}, quarantinedJobs: {} });
  }

  /**
   * List durable ordinary chapter-generation intents. These deliberately live
   * outside `jobs`, whose book-keyed records belong to premium preparation.
   */
  async listChapters() {
    let jobs = [];
    await jsonStore.update(this.filePath, data => {
      if (!data.version) data.version = 1;
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      for (const job of Object.values(data.chapterJobs)) {
        if (!job || typeof job !== 'object') continue;
        if (!Number.isInteger(job.attempts) || job.attempts < 0) job.attempts = 0;
        if (typeof job.status !== 'string') job.status = 'pending';
      }
      jobs = Object.values(data.chapterJobs).filter(job =>
        job && typeof job.bookId === 'string' && Number.isInteger(job.chapterIndex)
      );
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
    return jobs;
  }

  async listQuarantinedChapters() {
    const data = await jsonStore.load(this.filePath, {
      version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {}
    });
    return Object.values(data.quarantinedChapterJobs || {}).filter(job =>
      job && typeof job.bookId === 'string' && Number.isInteger(job.chapterIndex)
    );
  }

  put(job) {
    if (!job || typeof job.bookId !== 'string' || typeof job.variantKey !== 'string') {
      return Promise.reject(new TypeError('job requires bookId and variantKey'));
    }
    return jsonStore.update(this.filePath, data => {
      if (!data.version) data.version = 1;
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      this._migratePremiumJobs(data.jobs);
      data.jobs[this._premiumKey(job.bookId, job.variantKey)] = {
        bookId: job.bookId,
        variantKey: job.variantKey,
        fromChapter: Number.isInteger(job.fromChapter) ? job.fromChapter : 0,
        status: job.status || 'generating',
        updatedAt: Date.now()
      };
    }, { version: 1, jobs: {}, chapterJobs: {} });
  }

  remove(bookId, variantKey) {
    return jsonStore.update(this.filePath, data => {
      if (!data.jobs || typeof data.jobs !== 'object') return jsonStore.SKIP_SAVE;
      this._migratePremiumJobs(data.jobs);
      const key = this._premiumKey(bookId, variantKey);
      if (!data.jobs[key]) return jsonStore.SKIP_SAVE;
      delete data.jobs[key];
    }, { version: 1, jobs: {}, chapterJobs: {} });
  }

  _premiumKey(bookId, variantKey) {
    return `${bookId}\u0000${variantKey}`;
  }

  _migratePremiumJobs(jobs) {
    for (const [storedKey, job] of Object.entries(jobs)) {
      if (!job || typeof job.bookId !== 'string' || typeof job.variantKey !== 'string') continue;
      const canonicalKey = this._premiumKey(job.bookId, job.variantKey);
      if (storedKey === canonicalKey) continue;
      // Old state used bookId as the key. Prefer an already-present canonical
      // record because it is necessarily newer than the legacy layout.
      if (!jobs[canonicalKey]) jobs[canonicalKey] = job;
      delete jobs[storedKey];
    }
  }

  _chapterKey(bookId, chapterIndex, variantKey) {
    return `${bookId}\u0000${chapterIndex}\u0000${variantKey}`;
  }

  putChapter(job) {
    if (!job || typeof job.bookId !== 'string' || !Number.isInteger(job.chapterIndex) ||
        job.chapterIndex < 0 || typeof job.variantKey !== 'string' || typeof job.text !== 'string') {
      return Promise.reject(new TypeError('chapter job requires bookId, chapterIndex, variantKey, and text'));
    }
    return jsonStore.update(this.filePath, data => {
      if (!data.version) data.version = 1;
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      const key = this._chapterKey(job.bookId, job.chapterIndex, job.variantKey);
      const existing = data.chapterJobs[key];
      if (data.quarantinedChapterJobs[key]) {
        const error = new Error('Chapter generation is quarantined after exhausting its retry budget');
        error.code = 'GENERATION_QUARANTINED';
        throw error;
      }
      data.chapterJobs[key] = {
        kind: 'chapter',
        bookId: job.bookId,
        chapterIndex: job.chapterIndex,
        variantKey: job.variantKey,
        text: job.text,
        language: typeof job.language === 'string' ? job.language : 'en',
        priority: typeof job.priority === 'string' ? job.priority : 'background',
        voice: typeof job.voice === 'string' ? job.voice : null,
        chunkSize: Number.isFinite(job.chunkSize) && job.chunkSize > 0 ? Math.round(job.chunkSize) : null,
        attempts: Number.isInteger(existing?.attempts) && existing.attempts >= 0 ? existing.attempts : 0,
        status: 'pending',
        lastError: existing?.lastError || null,
        updatedAt: Date.now()
      };
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
  }

  recordChapterFailure(bookId, chapterIndex, variantKey, { error, permanent = false, maxAttempts = 3 } = {}) {
    let result = null;
    return jsonStore.update(this.filePath, data => {
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') return jsonStore.SKIP_SAVE;
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      const key = this._chapterKey(bookId, chapterIndex, variantKey);
      const job = data.chapterJobs[key];
      if (!job) return jsonStore.SKIP_SAVE;
      job.attempts = (Number.isInteger(job.attempts) ? job.attempts : 0) + 1;
      job.lastError = String(error?.message || error || 'Generation failed').slice(0, 500);
      job.lastFailureAt = Date.now();
      const exhausted = permanent || job.attempts >= Math.max(1, Number(maxAttempts) || 3);
      job.status = exhausted ? 'quarantined' : 'retryable';
      job.failureKind = permanent ? 'permanent' : 'transient';
      if (exhausted) {
        data.quarantinedChapterJobs[key] = job;
        delete data.chapterJobs[key];
      }
      result = { ...job, exhausted };
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} }).then(() => result);
  }

  clearChapterQuarantine(bookId, chapterIndex, variantKey) {
    return jsonStore.update(this.filePath, data => {
      const key = this._chapterKey(bookId, chapterIndex, variantKey);
      if (!data.quarantinedChapterJobs?.[key]) return jsonStore.SKIP_SAVE;
      delete data.quarantinedChapterJobs[key];
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
  }

  removeChapter(bookId, chapterIndex, variantKey) {
    return jsonStore.update(this.filePath, data => {
      const key = this._chapterKey(bookId, chapterIndex, variantKey);
      let changed = false;
      if (data.chapterJobs?.[key]) {
        delete data.chapterJobs[key];
        changed = true;
      }
      if (data.quarantinedChapterJobs?.[key]) {
        delete data.quarantinedChapterJobs[key];
        changed = true;
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
  }

  removeChaptersForBook(bookId) {
    return jsonStore.update(this.filePath, data => {
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') return jsonStore.SKIP_SAVE;
      let changed = false;
      for (const [key, job] of Object.entries(data.chapterJobs)) {
        if (job?.bookId !== bookId) continue;
        delete data.chapterJobs[key];
        changed = true;
      }
      for (const [key, job] of Object.entries(data.quarantinedChapterJobs || {})) {
        if (job?.bookId !== bookId) continue;
        delete data.quarantinedChapterJobs[key];
        changed = true;
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {} });
  }
}

module.exports = GenerationJournal;
