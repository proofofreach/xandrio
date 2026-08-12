/**
 * Durable journal for reconstructable generation work.
 *
 * The journal stores intent and ordering, never in-memory promises or claims
 * that audio exists. Recovery re-checks the audio cache before doing work.
 */
const jsonStore = require('./json-store');
const {
  GENERATION_ORIGIN,
  GENERATION_PRIORITY,
  TRANSIENT_GENERATION_ORIGINS
} = require('./audio-generation-intent');

const CHAPTER_PRIORITY_ORDER = Object.freeze({
  [GENERATION_PRIORITY.IMMEDIATE]: 0,
  [GENERATION_PRIORITY.NEXT]: 1,
  [GENERATION_PRIORITY.LOOKAHEAD]: 2,
  [GENERATION_PRIORITY.DOWNLOAD]: 3,
  [GENERATION_PRIORITY.BACKGROUND]: 4
});

function chapterClaim(value = {}) {
  const chunkIndexes = Array.isArray(value.chunkIndexes)
    ? [...new Set(value.chunkIndexes.filter(index => Number.isInteger(index) && index >= 0))]
      .sort((left, right) => left - right)
    : null;
  return {
    priority: typeof value.priority === 'string' ? value.priority : 'background',
    origin: typeof value.origin === 'string' && value.origin ? value.origin : null,
    requestId: typeof value.requestId === 'string' && value.requestId ? value.requestId : null,
    sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null,
    chunkIndexes
  };
}

function chapterClaimKey(claim) {
  return [claim.origin, claim.requestId, claim.sessionId]
    .map(value => value || '')
    .join('\u0000');
}

function chapterClaims(job) {
  if (!job || typeof job !== 'object') return [];
  const source = Array.isArray(job?.claims) && job.claims.length > 0
    ? job.claims
    : [job];
  const claims = [];
  for (const value of source) {
    const claim = chapterClaim(value);
    const key = chapterClaimKey(claim);
    const existing = claims.find(candidate => chapterClaimKey(candidate) === key);
    if (!existing) {
      claims.push(claim);
      continue;
    }
    const candidateWeight = CHAPTER_PRIORITY_ORDER[claim.priority] ?? CHAPTER_PRIORITY_ORDER.background;
    const existingWeight = CHAPTER_PRIORITY_ORDER[existing.priority] ?? CHAPTER_PRIORITY_ORDER.background;
    if (candidateWeight < existingWeight) existing.priority = claim.priority;
  }
  return claims;
}

function applyChapterClaims(job, claims) {
  const normalized = claims.map(chapterClaim);
  const primary = normalized.slice().sort((left, right) =>
    (CHAPTER_PRIORITY_ORDER[left.priority] ?? CHAPTER_PRIORITY_ORDER.background) -
    (CHAPTER_PRIORITY_ORDER[right.priority] ?? CHAPTER_PRIORITY_ORDER.background)
  )[0];
  job.claims = normalized;
  job.priority = primary.priority;
  job.origin = primary.origin;
  job.requestId = primary.requestId;
  job.sessionId = primary.sessionId;
  job.chunkIndexes = primary.chunkIndexes;
}

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
        applyChapterClaims(job, chapterClaims(job));
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

  /**
   * Run the one-time legacy intent migration and release transient claims on
   * every restart. Explicit downloads, premium jobs, quarantines, completed
   * audio, and any durable co-owner of a shared chapter are preserved.
   */
  async discardLegacySpeculativeChapters() {
    const transientOrigins = new Set([
      ...TRANSIENT_GENERATION_ORIGINS,
      'import-warm'
    ]);
    let report = {
      applied: true,
      discarded: 0,
      preserved: 0,
      discardedBookIds: []
    };
    await jsonStore.update(this.filePath, data => {
      if (!data.version) data.version = 1;
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      if (!data.offlinePreparations || typeof data.offlinePreparations !== 'object') {
        data.offlinePreparations = {};
      }
      const pendingBookResets = new Set(
        Array.isArray(data.pendingBookMetadataResets)
          ? data.pendingBookMetadataResets.filter(bookId => typeof bookId === 'string' && bookId)
          : []
      );
      const migrationRequired = (Number(data.generationIntentSchemaVersion) || 0) < 2;
      report.applied = migrationRequired;
      for (const [key, job] of Object.entries(data.chapterJobs)) {
        const claims = chapterClaims(job);
        const retained = claims.filter(claim => {
          const origin = typeof claim.origin === 'string' ? claim.origin.trim() : '';
          return !transientOrigins.has(origin) && (!migrationRequired || Boolean(origin));
        });
        const discarded = claims.filter(claim => !retained.includes(claim));
        const discardedClaims = claims.length - retained.length;
        if (discardedClaims === 0) {
          report.preserved += 1;
          continue;
        }
        report.discarded += discardedClaims;
        if (retained.length === 0) delete data.chapterJobs[key];
        else {
          applyChapterClaims(job, retained);
          job.updatedAt = Date.now();
          report.preserved += 1;
        }
        const requiresBookReset = migrationRequired || discarded.some(claim =>
          claim.origin === GENERATION_ORIGIN.IMPORT_WARMUP || claim.origin === 'import-warm'
        );
        if (requiresBookReset && typeof job?.bookId === 'string') pendingBookResets.add(job.bookId);
      }
      if (migrationRequired) data.generationIntentSchemaVersion = 2;
      data.pendingBookMetadataResets = [...pendingBookResets].sort();
      report.discardedBookIds = data.pendingBookMetadataResets.slice();
      if (!migrationRequired && report.discarded === 0) return jsonStore.SKIP_SAVE;
    }, {
      version: 1,
      jobs: {},
      chapterJobs: {},
      quarantinedChapterJobs: {},
      offlinePreparations: {}
    });
    return report;
  }

  acknowledgeBookMetadataResets(bookIds) {
    const acknowledged = new Set(
      Array.isArray(bookIds) ? bookIds.filter(bookId => typeof bookId === 'string' && bookId) : []
    );
    if (acknowledged.size === 0) return Promise.resolve();
    return jsonStore.update(this.filePath, data => {
      const pending = Array.isArray(data.pendingBookMetadataResets)
        ? data.pendingBookMetadataResets
        : [];
      const retained = pending.filter(bookId => !acknowledged.has(bookId));
      if (retained.length === pending.length) return jsonStore.SKIP_SAVE;
      data.pendingBookMetadataResets = retained;
    }, {
      version: 1,
      jobs: {},
      chapterJobs: {},
      quarantinedChapterJobs: {},
      offlinePreparations: {},
      pendingBookMetadataResets: []
    });
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

  removePremiumForBook(bookId) {
    return jsonStore.update(this.filePath, data => {
      if (!data.jobs || typeof data.jobs !== 'object') data.jobs = {};
      if (!data.quarantinedJobs || typeof data.quarantinedJobs !== 'object') {
        data.quarantinedJobs = {};
      }
      this._migratePremiumJobs(data.jobs);
      let changed = false;
      for (const records of [data.jobs, data.quarantinedJobs]) {
        for (const [key, record] of Object.entries(records)) {
          if (record?.bookId !== bookId) continue;
          delete records[key];
          changed = true;
        }
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, quarantinedJobs: {}, chapterJobs: {} });
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
      const next = {
        kind: 'chapter',
        bookId: job.bookId,
        chapterIndex: job.chapterIndex,
        variantKey: job.variantKey,
        text: job.text,
        language: typeof job.language === 'string' ? job.language : 'en',
        priority: typeof job.priority === 'string' ? job.priority : 'background',
        origin: typeof job.origin === 'string' && job.origin ? job.origin : null,
        requestId: typeof job.requestId === 'string' && job.requestId ? job.requestId : null,
        sessionId: typeof job.sessionId === 'string' && job.sessionId ? job.sessionId : null,
        chunkIndexes: Array.isArray(job.chunkIndexes) ? job.chunkIndexes : null,
        voice: typeof job.voice === 'string' ? job.voice : null,
        chunkSize: Number.isFinite(job.chunkSize) && job.chunkSize > 0 ? Math.round(job.chunkSize) : null,
        splitPolicy: typeof job.splitPolicy === 'string' ? job.splitPolicy : 'legacy-v1',
        attempts: Number.isInteger(existing?.attempts) && existing.attempts >= 0 ? existing.attempts : 0,
        status: 'pending',
        lastError: existing?.lastError || null,
        updatedAt: Date.now()
      };
      const claims = chapterClaims(existing);
      const incoming = chapterClaim(job);
      const incomingKey = chapterClaimKey(incoming);
      const matching = claims.find(claim => chapterClaimKey(claim) === incomingKey);
      if (matching) {
        const incomingWeight = CHAPTER_PRIORITY_ORDER[incoming.priority] ?? CHAPTER_PRIORITY_ORDER.background;
        const matchingWeight = CHAPTER_PRIORITY_ORDER[matching.priority] ?? CHAPTER_PRIORITY_ORDER.background;
        if (incomingWeight < matchingWeight) matching.priority = incoming.priority;
        matching.chunkIndexes = incoming.chunkIndexes;
      } else {
        claims.push(incoming);
      }
      applyChapterClaims(next, claims);
      data.chapterJobs[key] = next;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
  }

  async addChapterClaim(claim) {
    if (!claim || typeof claim.bookId !== 'string' || !Number.isInteger(claim.chapterIndex) ||
        claim.chapterIndex < 0 || typeof claim.variantKey !== 'string') {
      return false;
    }
    let added = false;
    await jsonStore.update(this.filePath, data => {
      const key = this._chapterKey(claim.bookId, claim.chapterIndex, claim.variantKey);
      const job = data.chapterJobs?.[key];
      if (!job) return jsonStore.SKIP_SAVE;
      const claims = chapterClaims(job);
      const incoming = chapterClaim(claim);
      const incomingKey = chapterClaimKey(incoming);
      const existing = claims.find(candidate => chapterClaimKey(candidate) === incomingKey);
      if (existing) {
        const incomingWeight = CHAPTER_PRIORITY_ORDER[incoming.priority] ?? CHAPTER_PRIORITY_ORDER.background;
        const existingWeight = CHAPTER_PRIORITY_ORDER[existing.priority] ?? CHAPTER_PRIORITY_ORDER.background;
        const scopeChanged = JSON.stringify(existing.chunkIndexes) !== JSON.stringify(incoming.chunkIndexes);
        if (incomingWeight >= existingWeight && !scopeChanged) return jsonStore.SKIP_SAVE;
        if (incomingWeight < existingWeight) existing.priority = incoming.priority;
        existing.chunkIndexes = incoming.chunkIndexes;
      } else {
        claims.push(incoming);
      }
      applyChapterClaims(job, claims);
      job.updatedAt = Date.now();
      added = true;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
    return added;
  }

  async removeChapterClaim(claim) {
    if (!claim || typeof claim.bookId !== 'string' || !Number.isInteger(claim.chapterIndex) ||
        claim.chapterIndex < 0 || typeof claim.variantKey !== 'string') {
      return false;
    }
    const expected = chapterClaim(claim);
    const expectedKey = chapterClaimKey(expected);
    let changed = false;
    await jsonStore.update(this.filePath, data => {
      const key = this._chapterKey(claim.bookId, claim.chapterIndex, claim.variantKey);
      for (const jobs of [data.chapterJobs || {}, data.quarantinedChapterJobs || {}]) {
        const job = jobs[key];
        if (!job) continue;
        const claims = chapterClaims(job);
        const retained = claims.filter(candidate =>
          chapterClaimKey(candidate) !== expectedKey || candidate.priority !== expected.priority
        );
        if (retained.length === claims.length) continue;
        if (retained.length === 0) delete jobs[key];
        else {
          applyChapterClaims(job, retained);
          job.updatedAt = Date.now();
        }
        changed = true;
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
    return changed;
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

  async removeChapterIndexes(bookId, chapterIndexes) {
    if (typeof bookId !== 'string' || !Array.isArray(chapterIndexes)) return 0;
    const indexes = new Set(chapterIndexes.filter(index => Number.isInteger(index) && index >= 0));
    if (indexes.size === 0) return 0;
    let removed = 0;
    await jsonStore.update(this.filePath, data => {
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      let changed = false;
      for (const jobs of [data.chapterJobs, data.quarantinedChapterJobs]) {
        for (const [key, job] of Object.entries(jobs)) {
          if (job?.bookId !== bookId || !indexes.has(job.chapterIndex)) continue;
          delete jobs[key];
          removed++;
          changed = true;
        }
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
    return removed;
  }

  async removeChaptersForRequest(requestId) {
    if (typeof requestId !== 'string' || !requestId) return 0;
    let removed = 0;
    let changed = false;
    await jsonStore.update(this.filePath, data => {
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      for (const jobs of [data.chapterJobs, data.quarantinedChapterJobs]) {
        for (const [key, job] of Object.entries(jobs)) {
          const claims = chapterClaims(job);
          const retained = claims.filter(claim => claim.requestId !== requestId);
          if (retained.length === claims.length) continue;
          if (retained.length === 0) {
            delete jobs[key];
            removed += 1;
          } else {
            applyChapterClaims(job, retained);
            job.updatedAt = Date.now();
          }
          changed = true;
        }
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
    return removed;
  }

  async removeChaptersByIntent({
    bookId,
    variantKey,
    origin,
    priority = null,
    chapterIndexes
  } = {}) {
    if (
      typeof bookId !== 'string' ||
      typeof variantKey !== 'string' ||
      typeof origin !== 'string' ||
      !Array.isArray(chapterIndexes)
    ) {
      return 0;
    }
    const indexes = new Set(chapterIndexes.filter(index => Number.isInteger(index) && index >= 0));
    if (indexes.size === 0) return 0;
    let removed = 0;
    let changed = false;
    await jsonStore.update(this.filePath, data => {
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.quarantinedChapterJobs || typeof data.quarantinedChapterJobs !== 'object') {
        data.quarantinedChapterJobs = {};
      }
      for (const jobs of [data.chapterJobs, data.quarantinedChapterJobs]) {
        for (const [key, job] of Object.entries(jobs)) {
          if (
            job?.bookId !== bookId ||
            job?.variantKey !== variantKey ||
            !indexes.has(job.chapterIndex)
          ) {
            continue;
          }
          const claims = chapterClaims(job);
          const retained = claims.filter(claim =>
            claim.origin !== origin || (priority && claim.priority !== priority)
          );
          if (retained.length === claims.length) continue;
          if (retained.length === 0) {
            delete jobs[key];
            removed += 1;
          } else {
            applyChapterClaims(job, retained);
            job.updatedAt = Date.now();
          }
          changed = true;
        }
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {}, quarantinedChapterJobs: {} });
    return removed;
  }

  putOfflinePreparation(record) {
    if (!record || typeof record.bookId !== 'string' ||
        !Number.isInteger(record.totalChapters) || record.totalChapters <= 0) {
      return Promise.reject(new TypeError('offline preparation requires bookId and totalChapters'));
    }
    return jsonStore.update(this.filePath, data => {
      if (!data.offlinePreparations || typeof data.offlinePreparations !== 'object') {
        data.offlinePreparations = {};
      }
      const existing = data.offlinePreparations[record.bookId] || {};
      const next = {
        ...existing,
        bookId: record.bookId,
        totalChapters: record.totalChapters,
        requestedAt: Number.isFinite(record.requestedAt) ? record.requestedAt : Date.now()
      };
      for (const field of [
        'state',
        'requestId',
        'lastError',
        'packageVariantKey',
        'sourceVariantKey',
        'sourceVoice'
      ]) {
        if (record[field] === null || typeof record[field] === 'string') next[field] = record[field];
      }
      for (const field of [
        'nextChapter',
        'readyChapters',
        'preparedBytes',
        'bitrateKbps',
        'sourceChunkSize',
        'updatedAt'
      ]) {
        if (Number.isFinite(record[field]) && record[field] >= 0) next[field] = record[field];
      }
      if (Array.isArray(record.owners)) {
        next.owners = [...new Set(record.owners.filter(owner =>
          typeof owner === 'string' && owner.length > 0 && owner.length <= 256
        ))];
      }
      data.offlinePreparations[record.bookId] = next;
    }, { version: 1, jobs: {}, chapterJobs: {}, offlinePreparations: {} });
  }

  async getOfflinePreparation(bookId) {
    const data = await jsonStore.load(this.filePath, {
      version: 1,
      jobs: {},
      chapterJobs: {},
      offlinePreparations: {}
    });
    const record = data.offlinePreparations?.[bookId];
    return record && typeof record === 'object' ? { ...record } : null;
  }

  async listOfflinePreparations() {
    const data = await jsonStore.load(this.filePath, {
      version: 1,
      jobs: {},
      chapterJobs: {},
      offlinePreparations: {}
    });
    return Object.values(data.offlinePreparations || {}).filter(record =>
      record &&
      typeof record.bookId === 'string' &&
      Number.isInteger(record.totalChapters) &&
      record.totalChapters > 0
    ).map(record => ({ ...record }));
  }

  removeOfflinePreparation(bookId) {
    return jsonStore.update(this.filePath, data => {
      if (!data.offlinePreparations?.[bookId]) return jsonStore.SKIP_SAVE;
      delete data.offlinePreparations[bookId];
    }, { version: 1, jobs: {}, chapterJobs: {}, offlinePreparations: {} });
  }

  removeChaptersForBook(bookId) {
    return jsonStore.update(this.filePath, data => {
      if (!data.chapterJobs || typeof data.chapterJobs !== 'object') data.chapterJobs = {};
      if (!data.offlinePreparations || typeof data.offlinePreparations !== 'object') {
        data.offlinePreparations = {};
      }
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
      if (data.offlinePreparations[bookId]) {
        delete data.offlinePreparations[bookId];
        changed = true;
      }
      return changed ? undefined : jsonStore.SKIP_SAVE;
    }, { version: 1, jobs: {}, chapterJobs: {}, offlinePreparations: {} });
  }
}

module.exports = GenerationJournal;
