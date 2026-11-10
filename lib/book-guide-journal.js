'use strict';

const jsonStoreDefault = require('./json-store');

const JOURNAL_VERSION = 1;
const CONTENT_FIELDS = new Set(['text', 'content', 'prompt', 'response', 'guide', 'chapters', 'sourceText', 'evidence']);

function emptyJournal() {
  return { version: JOURNAL_VERSION, jobs: {} };
}

function normalizeJournal(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : emptyJournal();
  data.version = JOURNAL_VERSION;
  if (!data.jobs || typeof data.jobs !== 'object' || Array.isArray(data.jobs)) data.jobs = {};
  return data;
}

function assertContentFree(value, path = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (CONTENT_FIELDS.has(key)) {
      throw new TypeError(`Book guide job journal cannot store content field ${[...path, key].join('.')}`);
    }
    assertContentFree(child, [...path, key]);
  }
}

function normalizeJob(job) {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || typeof job.bookId !== 'string') {
    throw new TypeError('Book guide job requires id and bookId');
  }
  const normalized = {
    id: job.id,
    bookId: job.bookId,
    status: String(job.status || 'pending'),
    phase: String(job.phase || 'queued'),
    current: Math.max(0, Number(job.current) || 0),
    total: Math.max(0, Number(job.total) || 0),
    reused: Math.max(0, Number(job.reused) || 0),
    attempt: Math.max(0, Number(job.attempt) || 0),
    sourceFingerprint: String(job.sourceFingerprint || ''),
    chapterStructureKey: String(job.chapterStructureKey || ''),
    nonfictionConfirmedAt: job.nonfictionConfirmedAt ? String(job.nonfictionConfirmedAt) : null,
    externalProcessingConfirmedAt: job.externalProcessingConfirmedAt
      ? String(job.externalProcessingConfirmedAt)
      : null,
    createdAt: String(job.createdAt || ''),
    startedAt: String(job.startedAt || job.createdAt || ''),
    phaseStartedAt: String(job.phaseStartedAt || job.updatedAt || job.createdAt || ''),
    updatedAt: String(job.updatedAt || job.createdAt || ''),
    errorCode: job.errorCode ? String(job.errorCode).slice(0, 100) : null
  };
  assertContentFree(normalized);
  return normalized;
}

function tryNormalizeJob(job) {
  try {
    return normalizeJob(job);
  } catch {
    return null;
  }
}

function createBookGuideJournal({ filePath, jsonStore = jsonStoreDefault, logger = console } = {}) {
  if (!filePath) throw new TypeError('filePath is required');
  const reportedInvalid = new Set();

  function reportInvalid(id) {
    if (reportedInvalid.has(id)) return;
    reportedInvalid.add(id);
    logger.warn?.(`Book guide journal ${filePath}: skipping malformed job entry ${JSON.stringify(String(id)).slice(0, 120)}`);
  }

  // One malformed entry must not make the whole journal unreadable: restore()
  // runs at startup, so a throw here was a boot loop. Malformed entries are
  // skipped on read and dropped by the next write.
  function validJobs(data) {
    const jobs = [];
    for (const [id, job] of Object.entries(data.jobs)) {
      const normalized = tryNormalizeJob(job);
      if (normalized) jobs.push(normalized);
      else reportInvalid(id);
    }
    return jobs;
  }

  function dropInvalid(data) {
    for (const [id, job] of Object.entries(data.jobs)) {
      if (tryNormalizeJob(job)) continue;
      reportInvalid(id);
      delete data.jobs[id];
    }
    return data;
  }

  async function list() {
    return validJobs(normalizeJournal(await jsonStore.load(filePath, emptyJournal())));
  }

  async function get(bookId) {
    return (await list()).find(job => job.bookId === bookId) || null;
  }

  async function put(job) {
    assertContentFree(job);
    const record = normalizeJob(job);
    await jsonStore.update(filePath, raw => {
      const data = dropInvalid(normalizeJournal(raw));
      for (const [id, current] of Object.entries(data.jobs)) {
        if (current?.bookId === record.bookId && id !== record.id) delete data.jobs[id];
      }
      data.jobs[record.id] = record;
    }, emptyJournal());
    return record;
  }

  async function update(jobId, patch) {
    assertContentFree(patch);
    let updated = null;
    await jsonStore.update(filePath, raw => {
      const data = normalizeJournal(raw);
      const current = data.jobs[jobId];
      if (!current) return jsonStore.SKIP_SAVE;
      if (!tryNormalizeJob(current)) {
        dropInvalid(data);
        return undefined;
      }
      updated = normalizeJob({ ...current, ...patch, id: current.id, bookId: current.bookId });
      data.jobs[jobId] = updated;
    }, emptyJournal());
    return updated;
  }

  async function remove(jobId) {
    let removed = false;
    await jsonStore.update(filePath, raw => {
      const data = dropInvalid(normalizeJournal(raw));
      if (!data.jobs[jobId]) return jsonStore.SKIP_SAVE;
      delete data.jobs[jobId];
      removed = true;
    }, emptyJournal());
    return removed;
  }

  async function removeBook(bookId) {
    let removed = 0;
    await jsonStore.update(filePath, raw => {
      const data = normalizeJournal(raw);
      for (const [id, job] of Object.entries(data.jobs)) {
        if (job?.bookId !== bookId) continue;
        delete data.jobs[id];
        removed++;
      }
      return removed > 0 ? undefined : jsonStore.SKIP_SAVE;
    }, emptyJournal());
    return removed;
  }

  return { get, list, put, remove, removeBook, update };
}

module.exports = {
  CONTENT_FIELDS,
  JOURNAL_VERSION,
  assertContentFree,
  createBookGuideJournal,
  emptyJournal,
  normalizeJob
};
