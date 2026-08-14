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
    attempt: Math.max(0, Number(job.attempt) || 0),
    sourceFingerprint: String(job.sourceFingerprint || ''),
    chapterStructureKey: String(job.chapterStructureKey || ''),
    nonfictionConfirmedAt: job.nonfictionConfirmedAt ? String(job.nonfictionConfirmedAt) : null,
    externalProcessingConfirmedAt: job.externalProcessingConfirmedAt
      ? String(job.externalProcessingConfirmedAt)
      : null,
    createdAt: String(job.createdAt || ''),
    updatedAt: String(job.updatedAt || job.createdAt || ''),
    errorCode: job.errorCode ? String(job.errorCode).slice(0, 100) : null
  };
  assertContentFree(normalized);
  return normalized;
}

function createBookGuideJournal({ filePath, jsonStore = jsonStoreDefault } = {}) {
  if (!filePath) throw new TypeError('filePath is required');

  async function list() {
    const data = normalizeJournal(await jsonStore.load(filePath, emptyJournal()));
    return Object.values(data.jobs).map(normalizeJob);
  }

  async function get(bookId) {
    return (await list()).find(job => job.bookId === bookId) || null;
  }

  async function put(job) {
    assertContentFree(job);
    const record = normalizeJob(job);
    await jsonStore.update(filePath, raw => {
      const data = normalizeJournal(raw);
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
      updated = normalizeJob({ ...current, ...patch, id: current.id, bookId: current.bookId });
      data.jobs[jobId] = updated;
    }, emptyJournal());
    return updated;
  }

  async function remove(jobId) {
    let removed = false;
    await jsonStore.update(filePath, raw => {
      const data = normalizeJournal(raw);
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
