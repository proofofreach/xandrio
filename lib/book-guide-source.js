'use strict';

const crypto = require('node:crypto');

const SOURCE_SCHEMA_VERSION = 1;
const NORMALIZATION_VERSION = 'nfkc-whitespace-v1';
const ENGLISH_COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'but', 'by', 'can',
  'do', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'if', 'in',
  'into', 'is', 'it', 'its', 'may', 'more', 'not', 'of', 'on', 'one', 'or', 'our',
  'she', 'so', 'than', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with',
  'would', 'you'
]);

function normalizeGuideText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function isEnglishLanguage(value) {
  const language = normalizeLanguage(value);
  return language === 'en' || language.startsWith('en-') || language === 'english';
}

function detectGuideLanguage(value) {
  const normalized = normalizeGuideText(value).toLocaleLowerCase('en');
  const letters = [...normalized].filter(character => /\p{L}/u.test(character));
  if (letters.length < 120) return 'und';
  const latinLetters = letters.filter(character => /\p{Script=Latin}/u.test(character)).length;
  if (latinLetters / letters.length < 0.95) return 'und';
  const tokens = normalized.match(/[a-z]+(?:'[a-z]+)?/g) || [];
  if (tokens.length < 24) return 'und';
  const sample = tokens.slice(0, 2000);
  const common = sample.filter(token => ENGLISH_COMMON_WORDS.has(token)).length;
  return common >= 5 && common / sample.length >= 0.08 ? 'en' : 'und';
}

function createBookGuideSourceSnapshot({ bookId, book = {}, chapters = [] }) {
  if (typeof bookId !== 'string' || !bookId) throw new TypeError('bookId is required');
  if (!Array.isArray(chapters) || chapters.length === 0) {
    const error = new Error('Book has no extracted chapters');
    error.code = 'BOOK_GUIDE_SOURCE_EMPTY';
    throw error;
  }

  let cursor = 0;
  const normalizedChapters = chapters.map((chapter, chapterIndex) => {
    const text = normalizeGuideText(chapter?.text);
    const start = cursor;
    const end = start + text.length;
    cursor = end + (chapterIndex < chapters.length - 1 ? 1 : 0);
    return {
      chapterIndex,
      title: normalizeGuideText(chapter?.title) || `Chapter ${chapterIndex + 1}`,
      type: normalizeGuideText(chapter?.type) || 'content',
      text,
      start,
      end,
      length: text.length,
      estimatedDuration: Math.max(0, Number(chapter?.estimatedDuration) || 0),
      chapterHash: sha256(text)
    };
  });
  const text = normalizedChapters.map(chapter => chapter.text).join(' ');
  if (!text) {
    const error = new Error('Book has no readable text');
    error.code = 'BOOK_GUIDE_SOURCE_EMPTY';
    throw error;
  }

  const declaredLanguage = normalizeLanguage(book.language);
  const language = declaredLanguage
    ? (isEnglishLanguage(declaredLanguage) ? 'en' : declaredLanguage)
    : detectGuideLanguage(text);
  return {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    bookId,
    language,
    chapterStructureKey: String(book.chapterStructureKey || ''),
    fingerprint: `sha256:${sha256(text)}`,
    text,
    chapters: normalizedChapters
  };
}

function publicSourceIdentity(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    fingerprint: snapshot.fingerprint,
    language: snapshot.language,
    chapterStructureKey: snapshot.chapterStructureKey,
    chapterCount: snapshot.chapters.length
  };
}

function createBookGuideAnchor(snapshot, { chapterIndex, start, end }) {
  const chapter = snapshot?.chapters?.[chapterIndex];
  if (!chapter) throw new RangeError('Anchor chapter does not exist');
  const rangeStart = Number(start);
  const rangeEnd = Number(end);
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) ||
      rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > chapter.length) {
    throw new RangeError('Anchor range is invalid');
  }
  const passage = chapter.text.slice(rangeStart, rangeEnd);
  const globalStart = chapter.start + rangeStart;
  const globalEnd = chapter.start + rangeEnd;
  const id = `a_${sha256([
    snapshot.bookId,
    snapshot.fingerprint,
    globalStart,
    globalEnd,
    passage
  ].join('\u0000')).slice(0, 24)}`;
  return {
    id,
    bookId: snapshot.bookId,
    chapterIndex,
    start: rangeStart,
    end: rangeEnd,
    globalStart,
    globalEnd,
    passageHash: `sha256:${sha256(passage)}`,
    chapterHash: `sha256:${chapter.chapterHash}`,
    sourceFingerprint: snapshot.fingerprint
  };
}

function resolveBookGuideAnchor(snapshot, anchor) {
  if (!snapshot || !anchor || anchor.bookId !== snapshot.bookId) return null;
  const globalStart = Number(anchor.globalStart);
  const globalEnd = Number(anchor.globalEnd);
  if (!Number.isInteger(globalStart) || !Number.isInteger(globalEnd) ||
      globalStart < 0 || globalEnd <= globalStart || globalEnd > snapshot.text.length) {
    return null;
  }
  const passage = snapshot.text.slice(globalStart, globalEnd);
  if (`sha256:${sha256(passage)}` !== anchor.passageHash) return null;
  const chapter = snapshot.chapters.find(candidate =>
    globalStart >= candidate.start && globalEnd <= candidate.end
  );
  if (!chapter) return null;
  const start = globalStart - chapter.start;
  const end = globalEnd - chapter.start;
  const ratio = chapter.length > 0 ? start / chapter.length : 0;
  return {
    anchorId: anchor.id,
    chapterIndex: chapter.chapterIndex,
    chapterTitle: chapter.title,
    start,
    end,
    passage,
    characterOffset: start,
    estimatedTimestamp: chapter.estimatedDuration > 0
      ? chapter.estimatedDuration * Math.max(0, Math.min(1, ratio))
      : 0,
    exact: true
  };
}

function boundedWords(value, maximum = 18) {
  const words = normalizeGuideText(value).split(' ').filter(Boolean);
  return words.slice(0, Math.max(0, Number(maximum) || 0)).join(' ');
}

function bookGuideAnchorContext(snapshot, anchor, maximumWords = 18) {
  const resolved = resolveBookGuideAnchor(snapshot, anchor);
  if (!resolved) return null;
  return {
    anchorId: resolved.anchorId,
    chapterIndex: resolved.chapterIndex,
    chapterTitle: resolved.chapterTitle,
    characterOffset: resolved.characterOffset,
    estimatedTimestamp: resolved.estimatedTimestamp,
    exact: true,
    text: boundedWords(resolved.passage, Math.min(18, maximumWords))
  };
}

function locateEvidence(snapshot, chapterIndex, evidence, { from = 0, to = null } = {}) {
  const chapter = snapshot?.chapters?.[chapterIndex];
  const needle = normalizeGuideText(evidence);
  if (!chapter || !needle) return null;
  const upper = to == null ? chapter.text.length : Math.min(chapter.text.length, Number(to));
  const lower = Math.max(0, Number(from) || 0);
  const segment = chapter.text.slice(lower, upper);
  let index = segment.indexOf(needle);
  if (index < 0) index = segment.toLocaleLowerCase('en').indexOf(needle.toLocaleLowerCase('en'));
  if (index >= 0) {
    const start = lower + index;
    return createBookGuideAnchor(snapshot, { chapterIndex, start, end: start + needle.length });
  }

  // Models sometimes normalize punctuation around an otherwise verbatim
  // citation. Recover only a sufficiently long, unique contiguous word run,
  // then anchor the exact source characters. Ambiguous matches fail closed.
  const tokenize = value => [...String(value).matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
    .map(match => ({ value: match[0].toLocaleLowerCase('en'), start: match.index, end: match.index + match[0].length }));
  const sourceTokens = tokenize(segment);
  const evidenceTokens = tokenize(needle);
  if (evidenceTokens.length < 4 || evidenceTokens.length > sourceTokens.length) return null;
  const matches = [];
  for (let candidate = 0; candidate <= sourceTokens.length - evidenceTokens.length; candidate++) {
    if (evidenceTokens.every((token, offset) => token.value === sourceTokens[candidate + offset].value)) {
      matches.push(candidate);
      if (matches.length > 1) return null;
    }
  }
  if (matches.length !== 1) return null;
  const first = sourceTokens[matches[0]];
  const last = sourceTokens[matches[0] + evidenceTokens.length - 1];
  return createBookGuideAnchor(snapshot, {
    chapterIndex,
    start: lower + first.start,
    end: lower + last.end
  });
}

module.exports = {
  ENGLISH_COMMON_WORDS,
  NORMALIZATION_VERSION,
  SOURCE_SCHEMA_VERSION,
  bookGuideAnchorContext,
  boundedWords,
  createBookGuideAnchor,
  createBookGuideSourceSnapshot,
  detectGuideLanguage,
  isEnglishLanguage,
  locateEvidence,
  normalizeGuideText,
  publicSourceIdentity,
  resolveBookGuideAnchor,
  sha256
};
