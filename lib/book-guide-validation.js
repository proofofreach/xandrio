'use strict';

const { normalizeGuideText } = require('./book-guide-source');

const ARTIFACT_SCHEMA_VERSION = 1;
const MAX_EXCERPT_WORDS = 18;
const MAX_TOTAL_EXCERPT_WORDS = 150;
const PROHIBITED_SOURCE_RUN_WORDS = 12;

function validationError(message, code = 'BOOK_GUIDE_VALIDATION_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function words(value) {
  return normalizeGuideText(value).toLocaleLowerCase('en').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function boundedQuoteWords(value, maximum = MAX_EXCERPT_WORDS) {
  const text = normalizeGuideText(value);
  const matches = [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
  const limit = Math.max(0, Number(maximum) || 0);
  if (matches.length <= limit) return text;
  if (limit === 0) return '';
  const last = matches[limit - 1];
  return text.slice(0, last.index + last[0].length).trim();
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${label} is required`);
}

function allStrings(value, path = [], output = []) {
  if (typeof value === 'string') output.push({ path, value });
  else if (Array.isArray(value)) value.forEach((item, index) => allStrings(item, [...path, index], output));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) allStrings(child, [...path, key], output);
  }
  return output;
}

function isApprovedExcerptPath(path) {
  return path.length === 4 && path[0] === 'guide' && path[1] === 'keyPassages' &&
    Number.isInteger(path[2]) && path[3] === 'text';
}

function isBibliographicTitlePath(path) {
  return path.length === 4 && path[0] === 'guide' && path[1] === 'chapterMap' &&
    Number.isInteger(path[2]) && path[3] === 'title';
}

function containsSourceRun(value, sourceNgrams) {
  const tokens = words(value).map(word => word.toLocaleLowerCase('en'));
  for (let index = 0; index <= tokens.length - PROHIBITED_SOURCE_RUN_WORDS; index++) {
    if (sourceNgrams.has(tokens.slice(index, index + PROHIBITED_SOURCE_RUN_WORDS).join(' '))) return true;
  }
  return false;
}

function guidePath(path) {
  return path.slice(path[0] === 'guide' ? 1 : 0).map((part, index) =>
    Number.isInteger(part) ? `[${part}]` : `${index > 0 ? '.' : ''}${part}`
  ).join('').replace(/\.\[/g, '[');
}

function validatePersistedQuoteControls(artifact, snapshot) {
  const excerpts = artifact?.guide?.keyPassages || [];
  let total = 0;
  for (const [index, excerpt] of excerpts.entries()) {
    assertString(excerpt?.text, `guide.keyPassages[${index}].text`);
    const count = words(excerpt.text).length;
    if (count > MAX_EXCERPT_WORDS) {
      throw validationError(`Stored excerpt ${index} exceeds ${MAX_EXCERPT_WORDS} words`, 'BOOK_GUIDE_QUOTE_LIMIT');
    }
    total += count;
  }
  if (total > MAX_TOTAL_EXCERPT_WORDS) {
    throw validationError(`Stored excerpts exceed ${MAX_TOTAL_EXCERPT_WORDS} total words`, 'BOOK_GUIDE_QUOTE_LIMIT');
  }

  if (!snapshot?.text) return true;
  const sourceTokens = words(snapshot.text).map(word => word.toLocaleLowerCase('en'));
  const sourceNgrams = new Set();
  for (let index = 0; index <= sourceTokens.length - PROHIBITED_SOURCE_RUN_WORDS; index++) {
    sourceNgrams.add(sourceTokens.slice(index, index + PROHIBITED_SOURCE_RUN_WORDS).join(' '));
  }
  for (const item of allStrings(artifact)) {
    if (isApprovedExcerptPath(item.path) || isBibliographicTitlePath(item.path)) continue;
    if (containsSourceRun(item.value, sourceNgrams)) {
      const error = validationError(
        `Unapproved source quotation at ${item.path.join('.')}`,
        'BOOK_GUIDE_QUOTE_LIMIT'
      );
      error.guidePath = guidePath(item.path);
      throw error;
    }
  }
  return true;
}

function validateAnchorReferences(artifact) {
  const anchors = artifact.anchors;
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) {
    throw validationError('anchors must be an object');
  }
  for (const [id, anchor] of Object.entries(anchors)) {
    if (anchor?.id !== id || typeof anchor.passageHash !== 'string') {
      throw validationError(`Anchor ${id} is invalid`);
    }
  }
  for (const { path, value } of allStrings(artifact.guide)) {
    if (path.at(-1) !== 'anchorId') continue;
    if (!anchors[value]) throw validationError(`Unknown anchor ${value} at guide.${path.join('.')}`);
  }
  function walk(value, path = []) {
    if (Array.isArray(value)) {
      if (path.at(-1) === 'anchorIds') {
        if (value.length === 0 || value.some(id => typeof id !== 'string' || !anchors[id])) {
          throw validationError(`Invalid anchorIds at guide.${path.join('.')}`);
        }
      } else value.forEach((child, index) => walk(child, [...path, index]));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    }
  }
  walk(artifact.guide);
}

function validateBookGuideArtifact(artifact, { snapshot = null } = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw validationError('Artifact must be an object');
  }
  if (artifact.schemaVersion !== ARTIFACT_SCHEMA_VERSION || artifact.status !== 'ready') {
    throw validationError('Artifact schema or status is invalid');
  }
  assertString(artifact.bookId, 'bookId');
  assertString(artifact.source?.fingerprint, 'source.fingerprint');
  if (snapshot && artifact.source.fingerprint !== snapshot.fingerprint) {
    throw validationError('Artifact source fingerprint is stale', 'BOOK_GUIDE_SOURCE_CHANGED');
  }
  if (artifact.source?.language !== 'en' && !String(artifact.source?.language || '').startsWith('en-')) {
    throw validationError('Artifact language must be English');
  }
  assertString(artifact.models?.generator?.name, 'models.generator.name');
  assertString(artifact.models?.generator?.digest, 'models.generator.digest');
  assertString(artifact.models?.verifier?.name, 'models.verifier.name');
  assertString(artifact.models?.verifier?.digest, 'models.verifier.digest');
  const guide = artifact.guide;
  if (!guide || typeof guide !== 'object') throw validationError('guide is required');
  assertString(guide.orientation?.thesis?.text, 'guide.orientation.thesis.text');
  if (!Array.isArray(guide.coreIdeas) || guide.coreIdeas.length === 0) {
    throw validationError('guide.coreIdeas must not be empty');
  }
  if (!Array.isArray(guide.chapterMap) || guide.chapterMap.length === 0) {
    throw validationError('guide.chapterMap must not be empty');
  }
  if (!Array.isArray(guide.review?.questions)) throw validationError('guide.review.questions must be an array');
  if (!Array.isArray(guide.keyPassages)) throw validationError('guide.keyPassages must be an array');
  const verification = artifact.verification;
  if (verification?.allClaimsChecked !== true || verification?.unsupportedCount !== 0 ||
      !Number.isInteger(verification?.materialItemCount) || verification.materialItemCount < 1 ||
      !Number.isInteger(verification?.checkedItemCount) ||
      verification.checkedItemCount < verification.materialItemCount ||
      verification.claimCount !== verification.checkedItemCount) {
    throw validationError('Artifact semantic verification record is incomplete');
  }
  validateAnchorReferences(artifact);
  validatePersistedQuoteControls(artifact, snapshot);
  return true;
}

module.exports = {
  ARTIFACT_SCHEMA_VERSION,
  MAX_EXCERPT_WORDS,
  MAX_TOTAL_EXCERPT_WORDS,
  PROHIBITED_SOURCE_RUN_WORDS,
  boundedQuoteWords,
  validateBookGuideArtifact,
  validatePersistedQuoteControls,
  validationError
};
