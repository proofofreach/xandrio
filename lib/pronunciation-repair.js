const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const STORE_VERSION = 1;
const MAX_RULES_PER_SCOPE = 500;
const MAX_SOURCE_LENGTH = 160;
const MAX_REPLACEMENT_LENGTH = 240;

class PronunciationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PronunciationError';
    this.statusCode = statusCode;
  }
}

function normalizeStore(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const books = source.books && typeof source.books === 'object' && !Array.isArray(source.books)
    ? source.books
    : {};
  return {
    version: STORE_VERSION,
    global: Array.isArray(source.global) ? source.global : [],
    books
  };
}

function cleanPhrase(value, field, maxLength) {
  if (typeof value !== 'string') throw new PronunciationError(`${field} must be a string`);
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!cleaned) throw new PronunciationError(`${field} is required`);
  if (cleaned.length > maxLength) throw new PronunciationError(`${field} is too long`);
  return cleaned;
}

function sanitizeRuleInput(input, existing = null) {
  const body = input && typeof input === 'object' ? input : {};
  const source = body.source === undefined && existing
    ? existing.source
    : cleanPhrase(body.source, 'source', MAX_SOURCE_LENGTH);
  const replacement = body.replacement === undefined && existing
    ? existing.replacement
    : cleanPhrase(body.replacement, 'replacement', MAX_REPLACEMENT_LENGTH);
  return {
    source,
    replacement,
    caseSensitive: body.caseSensitive === undefined
      ? (existing?.caseSensitive ?? false)
      : body.caseSensitive === true,
    wholeWord: body.wholeWord === undefined
      ? (existing?.wholeWord ?? true)
      : body.wholeWord !== false
  };
}

function isWordCharacter(character) {
  return Boolean(character && /[\p{L}\p{N}_]/u.test(character));
}

function ruleMatchesAt(text, start, rule, matchLength = rule.source.length) {
  const end = start + matchLength;
  if (!rule.wholeWord) return true;
  return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end]);
}

function findRuleMatches(text, rules) {
  const haystack = String(text || '');
  const matches = [];
  rules.forEach((rule, ruleOrder) => {
    if (!rule?.source) return;
    const pattern = new RegExp(escapeRegExp(rule.source), rule.caseSensitive ? 'gu' : 'giu');
    for (const match of haystack.matchAll(pattern)) {
      const start = match.index;
      if (ruleMatchesAt(haystack, start, rule, match[0].length)) {
        matches.push({ start, end: start + match[0].length, rule, ruleOrder });
      }
    }
  });
  return matches;
}

function applyPronunciationRules(text, rules) {
  const sourceText = String(text || '');
  const candidates = findRuleMatches(sourceText, Array.isArray(rules) ? rules : [])
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.ruleOrder - b.ruleOrder);
  if (candidates.length === 0) return sourceText;

  const accepted = [];
  let occupiedUntil = -1;
  for (const candidate of candidates) {
    if (candidate.start < occupiedUntil) continue;
    accepted.push(candidate);
    occupiedUntil = candidate.end;
  }

  let result = '';
  let cursor = 0;
  for (const match of accepted) {
    result += sourceText.slice(cursor, match.start) + match.rule.replacement;
    cursor = match.end;
  }
  return result + sourceText.slice(cursor);
}

function effectiveRules(store, bookId) {
  const normalized = normalizeStore(store);
  const globalRules = normalized.global.map(rule => ({ ...rule, scope: 'global' }));
  const bookRules = (normalized.books[bookId] || []).map(rule => ({ ...rule, scope: 'book', bookId }));
  // A book rule with the same matching semantics deliberately overrides global.
  const bookKeys = new Set(bookRules.map(rule => ruleIdentity(rule)));
  return [...bookRules, ...globalRules.filter(rule => !bookKeys.has(ruleIdentity(rule)))];
}

function ruleIdentity(rule) {
  const source = rule.caseSensitive ? rule.source : String(rule.source).toLocaleLowerCase();
  return `${source}\u0000${rule.caseSensitive ? 1 : 0}\u0000${rule.wholeWord ? 1 : 0}`;
}

function firstChangedChunk(before, after) {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index++) {
    if (before[index] !== after[index]) return index;
  }
  return -1;
}

function bookEntries(rawBooks) {
  return Object.entries(rawBooks && typeof rawBooks === 'object' ? rawBooks : {});
}

async function collectAffectedChapters({ beforeStore, afterStore, scope, bookId, loadBooks, getChapters, splitIntoChunks, chunkVariants }) {
  const books = await loadBooks();
  const candidates = scope === 'book'
    ? (books[bookId] ? [[bookId, books[bookId]]] : [])
    : bookEntries(books);
  const affected = [];

  for (const [candidateBookId, book] of candidates) {
    const chapters = await getChapters(candidateBookId, book);
    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
      const text = String(chapters[chapterIndex]?.text || '');
      const beforeText = applyPronunciationRules(text, effectiveRules(beforeStore, candidateBookId));
      const afterText = applyPronunciationRules(text, effectiveRules(afterStore, candidateBookId));
      if (beforeText === afterText) continue;
      const beforeChunks = splitIntoChunks(beforeText);
      const afterChunks = splitIntoChunks(afterText);
      const fromChunkIndexByVariant = {};
      const strategies = typeof chunkVariants === 'function' ? chunkVariants() : [];
      for (const strategy of strategies) {
        if (!strategy || typeof strategy.splitIntoChunks !== 'function') continue;
        const variantSegment = String(strategy.variantSegment || '');
        fromChunkIndexByVariant[variantSegment] = Math.max(0, firstChangedChunk(
          strategy.splitIntoChunks(beforeText),
          strategy.splitIntoChunks(afterText)
        ));
      }
      affected.push({
        bookId: candidateBookId,
        chapterIndex,
        fromChunkIndex: Math.max(0, firstChangedChunk(beforeChunks, afterChunks)),
        fromChunkIndexByVariant,
        previousChunkCount: beforeChunks.length,
        nextChunkCount: afterChunks.length
      });
    }
  }
  return affected;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createCacheInvalidator(cacheDir) {
  return async function invalidateCache(affected) {
    const entries = await fs.readdir(cacheDir).catch(err => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const removed = [];
    for (const item of affected) {
      const prefix = `${escapeRegExp(item.bookId)}(?:_tts[a-f0-9]{10})?_ch${item.chapterIndex}`;
      const chunkPattern = new RegExp(`^${escapeRegExp(item.bookId)}(_tts[a-f0-9]{10})?_ch${item.chapterIndex}_chunk(\\d+)\\.(?:mp3|wav)$`);
      const chapterArtifactPattern = new RegExp(`^${prefix}(?:\\.(?:mp3|wav|m4a|texthash)|_concat(?:_clean)?\\.txt)$`);
      const targets = entries.filter(name => {
        const chunkMatch = name.match(chunkPattern);
        if (chunkMatch) {
          const variantSegment = chunkMatch[1] || '';
          const boundaries = item.fromChunkIndexByVariant || {};
          // Historical variants cannot be mapped back to their chunk size from
          // a hash alone. Invalidate them conservatively from chunk zero; only
          // current variants with an explicit strategy retain unaffected audio.
          const boundary = Object.hasOwn(boundaries, variantSegment)
            ? Number(boundaries[variantSegment])
            : (variantSegment === '' ? Number(item.fromChunkIndex) : 0);
          return Number(chunkMatch[2]) >= Math.max(0, boundary || 0);
        }
        return chapterArtifactPattern.test(name);
      });
      await Promise.all(targets.map(async name => {
        await fs.unlink(path.join(cacheDir, name)).catch(err => {
          if (err.code !== 'ENOENT') throw err;
        });
        removed.push(name);
      }));
    }
    return removed;
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPronunciationService({
  storeFile,
  jsonStore,
  loadBooks,
  getChapters,
  splitIntoChunks,
  chunkVariants,
  beforeInvalidate = async () => {},
  invalidateCache = async () => [],
  onInvalidated = async () => {}
}) {
  if (!storeFile || !jsonStore?.load || !jsonStore?.update) throw new Error('Pronunciation persistence is not configured');
  if (!loadBooks || !getChapters || !splitIntoChunks) throw new Error('Pronunciation chapter access is not configured');

  async function readStore() {
    return normalizeStore(await jsonStore.load(storeFile, normalizeStore()));
  }

  async function list(bookId) {
    const store = await readStore();
    return {
      global: store.global,
      book: bookId ? (store.books[bookId] || []) : [],
      effective: bookId ? effectiveRules(store, bookId) : store.global
    };
  }

  async function mutate({ operation, scope, bookId, id, input }) {
    if (scope !== 'global' && scope !== 'book') throw new PronunciationError('scope must be global or book');
    if (scope === 'book' && !bookId) throw new PronunciationError('bookId is required for book rules');
    if (scope === 'book' && !(await loadBooks())[bookId]) throw new PronunciationError('Book not found', 404);
    let result;
    let beforeStore;
    let afterStore;

    await jsonStore.update(storeFile, raw => {
      const store = normalizeStore(raw);
      Object.keys(raw).forEach(key => delete raw[key]);
      Object.assign(raw, store);
      beforeStore = clone(store);
      const rules = scope === 'global' ? raw.global : (raw.books[bookId] ||= []);

      if (operation === 'create') {
        if (rules.length >= MAX_RULES_PER_SCOPE) throw new PronunciationError('Pronunciation rule limit reached');
        const fields = sanitizeRuleInput(input);
        if (rules.some(rule => ruleIdentity(rule) === ruleIdentity(fields))) {
          throw new PronunciationError('A matching pronunciation rule already exists', 409);
        }
        const now = new Date().toISOString();
        result = { id: `pron_${crypto.randomBytes(8).toString('hex')}`, ...fields, createdAt: now, updatedAt: now };
        rules.push(result);
      } else {
        const index = rules.findIndex(rule => rule.id === id);
        if (index === -1) throw new PronunciationError('Pronunciation rule not found', 404);
        if (operation === 'delete') {
          result = rules.splice(index, 1)[0];
        } else if (operation === 'update') {
          const fields = sanitizeRuleInput(input, rules[index]);
          if (rules.some((rule, otherIndex) => otherIndex !== index && ruleIdentity(rule) === ruleIdentity(fields))) {
            throw new PronunciationError('A matching pronunciation rule already exists', 409);
          }
          result = { ...rules[index], ...fields, updatedAt: new Date().toISOString() };
          rules[index] = result;
        } else {
          throw new Error(`Unsupported operation: ${operation}`);
        }
      }
      if (scope === 'book' && raw.books[bookId]?.length === 0) delete raw.books[bookId];
      afterStore = clone(raw);
    }, normalizeStore());

    const affected = await collectAffectedChapters({
      beforeStore,
      afterStore,
      scope,
      bookId,
      loadBooks,
      getChapters,
      splitIntoChunks,
      chunkVariants
    });
    // Cancel or detach in-memory generation before deleting its outputs. This
    // hook prevents an already-running stale job from recreating a removed file.
    await beforeInvalidate(affected);
    const removedFiles = await invalidateCache(affected);
    await onInvalidated(affected);
    return { rule: result, affected, removedFiles };
  }

  return {
    list,
    create: options => mutate({ operation: 'create', ...options }),
    update: options => mutate({ operation: 'update', ...options }),
    remove: options => mutate({ operation: 'delete', ...options }),
    async apply(text, bookId) {
      return applyPronunciationRules(text, effectiveRules(await readStore(), bookId));
    }
  };
}

module.exports = {
  PronunciationError,
  applyPronunciationRules,
  createCacheInvalidator,
  createPronunciationService,
  effectiveRules,
  firstChangedChunk,
  normalizeStore,
  sanitizeRuleInput
};
