'use strict';

// This module deliberately evaluates only operator-supplied measurements. It
// neither reads book text nor contacts a model/provider. That keeps the release
// gate reproducible and makes its default execution safe for a private library.

const crypto = require('node:crypto');

const REQUIRED_WORKS = 12;
const REQUIRED_CALIBRATION_CLAIMS = 200;
const REQUIRED_CALIBRATION_PER_LABEL = 100;
const REQUIRED_CALIBRATION_BOOKS = 6;
const REQUIRED_NONFICTION_SHAPES = 3;
const MIN_CLAIMS_PER_WORK = 20;
const MIN_RECALL_PER_WORK = 8;
const MIN_SUPPORTED_RATE = 0.95;
const MIN_RECALL_ANSWER_RATE = 0.95;
const MIN_RECALL_USEFUL_RATE = 0.80;
const MIN_QUALITY_RATING = 4;
const MIN_UNSUPPORTED_RECALL = 0.90;
const MIN_UNSUPPORTED_PRECISION = 0.90;
const MIN_AUDIO_SEEK_RATE = 0.90;
const MAX_STORED_QUOTE_WORDS = 150;
const MAX_STORED_EXCERPT_WORDS = 18;
const MAX_OUTSIDE_EXCERPT_SEQUENCE_WORDS = 11;

const ALLOWED_SHAPES = new Set([
  'prescriptive', 'argumentative', 'historical', 'biographical', 'narrative', 'technical'
]);
const OPAQUE_WORK_ID = /^work-[a-f0-9]{12,64}$/;
const OPAQUE_CLAIM_ID = /^claim-[a-f0-9]{12,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_RESULT_KEYS = new Set([
  'title', 'author', 'creator', 'description', 'text', 'quote', 'excerpt', 'excerpts',
  'passage', 'passages', 'chapterText', 'sourceText', 'sourcePath', 'path', 'filename', 'url',
  'credential', 'credentials', 'apiKey', 'token', 'secret', 'prompt', 'response', 'rawResponse'
]);

function fail(message) {
  throw new Error(`Book-guide evaluation invalid: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, label, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) fail(`${label} must be an integer >= ${min}`);
  return value;
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function rounded(value) {
  return Math.round(value * 10_000) / 10_000;
}

function assertNoPrivateOutput(value, label = 'results') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateOutput(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) fail(`${label}.${key} is private or raw content metadata`);
    assertNoPrivateOutput(item, `${label}.${key}`);
  }
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
}

function validateManifest(manifest) {
  assertExactKeys(manifest, ['schemaVersion', 'works'], 'manifest');
  if (manifest.schemaVersion !== 1) fail('manifest.schemaVersion must be 1');
  if (!Array.isArray(manifest.works) || manifest.works.length < REQUIRED_WORKS) {
    fail(`manifest requires at least ${REQUIRED_WORKS} works`);
  }
  const ids = new Set();
  const shapes = new Set();
  for (const [index, work] of manifest.works.entries()) {
    assertExactKeys(work, ['id', 'localPath', 'sourceFingerprint', 'language', 'nonfictionShape', 'rights'], `manifest.works[${index}]`);
    if (!OPAQUE_WORK_ID.test(work.id) || ids.has(work.id)) fail(`manifest work ${index} must have a unique opaque id`);
    ids.add(work.id);
    if (typeof work.localPath !== 'string' || !work.localPath || work.localPath.includes('\0')) {
      fail(`manifest work ${index}.localPath is required`);
    }
    if (!SHA256.test(work.sourceFingerprint)) fail(`manifest work ${index}.sourceFingerprint must be lowercase SHA-256`);
    if (work.language !== 'en') fail(`manifest work ${index} must be English (language: en)`);
    if (!ALLOWED_SHAPES.has(work.nonfictionShape)) fail(`manifest work ${index}.nonfictionShape is invalid`);
    shapes.add(work.nonfictionShape);
    assertExactKeys(work.rights, ['basis', 'attested'], `manifest work ${index}.rights`);
    if (!['public-domain', 'licensed', 'operator-authorized'].includes(work.rights.basis) || work.rights.attested !== true) {
      fail(`manifest work ${index} needs an attested legally usable rights basis`);
    }
  }
  if (shapes.size < REQUIRED_NONFICTION_SHAPES) {
    fail(`manifest needs at least ${REQUIRED_NONFICTION_SHAPES} nonfiction shapes`);
  }
  return {
    workIds: ids,
    shapes,
    sourceFingerprints: new Map(manifest.works.map(work => [work.id, work.sourceFingerprint])),
    workShapes: new Map(manifest.works.map(work => [work.id, work.nonfictionShape]))
  };
}

function validateCalibration(calibration, manifestInfo) {
  assertNoPrivateOutput(calibration, 'calibration');
  assertExactKeys(calibration, ['schemaVersion', 'claims'], 'calibration');
  if (calibration.schemaVersion !== 1) fail('calibration.schemaVersion must be 1');
  if (!Array.isArray(calibration.claims) || calibration.claims.length !== REQUIRED_CALIBRATION_CLAIMS) {
    fail(`calibration requires exactly ${REQUIRED_CALIBRATION_CLAIMS} claims`);
  }
  const ids = new Set();
  const books = new Set();
  const shapes = new Set();
  const labels = { supported: 0, unsupported: 0 };
  const matrix = { truePositive: 0, falseNegative: 0, falsePositive: 0, trueNegative: 0 };
  for (const [index, claim] of calibration.claims.entries()) {
    assertExactKeys(claim, ['id', 'bookId', 'label', 'verifierVerdict'], `calibration.claims[${index}]`);
    if (!OPAQUE_CLAIM_ID.test(claim.id) || ids.has(claim.id)) fail(`calibration claim ${index} must have a unique opaque id`);
    ids.add(claim.id);
    if (!manifestInfo.workIds.has(claim.bookId)) fail(`calibration claim ${index} references a manifest work`);
    books.add(claim.bookId);
    shapes.add(manifestInfo.workShapes.get(claim.bookId));
    if (!Object.hasOwn(labels, claim.label)) fail(`calibration claim ${index}.label is invalid`);
    if (!['supported', 'unsupported'].includes(claim.verifierVerdict)) fail(`calibration claim ${index}.verifierVerdict is invalid`);
    labels[claim.label]++;
    if (claim.label === 'unsupported' && claim.verifierVerdict === 'unsupported') matrix.truePositive++;
    if (claim.label === 'unsupported' && claim.verifierVerdict === 'supported') matrix.falseNegative++;
    if (claim.label === 'supported' && claim.verifierVerdict === 'unsupported') matrix.falsePositive++;
    if (claim.label === 'supported' && claim.verifierVerdict === 'supported') matrix.trueNegative++;
  }
  if (labels.supported !== REQUIRED_CALIBRATION_PER_LABEL || labels.unsupported !== REQUIRED_CALIBRATION_PER_LABEL) {
    fail(`calibration requires exactly ${REQUIRED_CALIBRATION_PER_LABEL} supported and ${REQUIRED_CALIBRATION_PER_LABEL} unsupported claims`);
  }
  if (books.size < REQUIRED_CALIBRATION_BOOKS) fail(`calibration requires claims from at least ${REQUIRED_CALIBRATION_BOOKS} books`);
  if (shapes.size < REQUIRED_NONFICTION_SHAPES) {
    fail(`calibration requires claims across at least ${REQUIRED_NONFICTION_SHAPES} nonfiction shapes`);
  }
  return { labels, books: books.size, shapes: shapes.size, matrix };
}

function validateResults(results, manifestInfo) {
  assertNoPrivateOutput(results, 'results');
  assertExactKeys(results, ['schemaVersion', 'provenance', 'works'], 'results');
  if (results.schemaVersion !== 1) fail('results.schemaVersion must be 1');
  assertExactKeys(results.provenance, ['generatorModel', 'verifierModel', 'recipeHash', 'extractionVersion', 'normalizationVersion'], 'results.provenance');
  for (const key of ['generatorModel', 'verifierModel', 'extractionVersion', 'normalizationVersion']) {
    if (typeof results.provenance[key] !== 'string' || !results.provenance[key].trim()) fail(`results.provenance.${key} is required`);
  }
  if (!SHA256.test(results.provenance.recipeHash)) fail('results.provenance.recipeHash must be lowercase SHA-256');
  if (!Array.isArray(results.works) || results.works.length !== manifestInfo.workIds.size) fail('results must contain exactly one evaluation for each manifest work');
  const workIds = new Set();
  const measured = [];
  for (const [index, work] of results.works.entries()) {
    assertExactKeys(work, ['bookId', 'sourceFingerprint', 'claims', 'quality', 'recall', 'anchors', 'quotes'], `results.works[${index}]`);
    if (!manifestInfo.workIds.has(work.bookId) || workIds.has(work.bookId)) fail(`results work ${index} must reference one unique manifest work`);
    workIds.add(work.bookId);
    if (!SHA256.test(work.sourceFingerprint)) fail(`results work ${index}.sourceFingerprint must be lowercase SHA-256`);
    if (manifestInfo.sourceFingerprints.get(work.bookId) !== work.sourceFingerprint) {
      fail(`results work ${index}.sourceFingerprint does not match its manifest work`);
    }
    assertExactKeys(work.claims, ['sampled', 'fullySupported', 'materialFabrications'], `results work ${index}.claims`);
    assertExactKeys(work.quality, ['centralIdeaCoverageReviews', 'usefulnessReviews'], `results work ${index}.quality`);
    assertExactKeys(work.recall, ['available', 'sampled', 'correctAndAnswerable', 'nonTrivialUsefulBoth', 'fabricatedAnswers'], `results work ${index}.recall`);
    assertExactKeys(work.anchors, ['resolved', 'sampled', 'navigation'], `results work ${index}.anchors`);
    assertExactKeys(work.quotes, ['storedSourceWords', 'maxExcerptWords', 'maxOutsideExcerptSequenceWords'], `results work ${index}.quotes`);
    const claims = {
      sampled: integer(work.claims.sampled, `results work ${index}.claims.sampled`, { min: MIN_CLAIMS_PER_WORK }),
      fullySupported: integer(work.claims.fullySupported, `results work ${index}.claims.fullySupported`),
      materialFabrications: integer(work.claims.materialFabrications, `results work ${index}.claims.materialFabrications`)
    };
    if (claims.fullySupported > claims.sampled || claims.materialFabrications > claims.sampled) fail(`results work ${index} has impossible claim counts`);
    for (const field of ['centralIdeaCoverageReviews', 'usefulnessReviews']) {
      const reviews = work.quality[field];
      if (!Array.isArray(reviews) || reviews.length !== 2 || reviews.some(value => !Number.isFinite(value) || value < 1 || value > 5)) {
        fail(`results work ${index}.quality.${field} needs exactly two 1–5 reviewer scores`);
      }
    }
    const recall = work.recall;
    if (typeof recall.available !== 'boolean') fail(`results work ${index}.recall.available must be boolean`);
    for (const field of ['sampled', 'correctAndAnswerable', 'nonTrivialUsefulBoth', 'fabricatedAnswers']) integer(recall[field], `results work ${index}.recall.${field}`);
    if (recall.available && recall.sampled < MIN_RECALL_PER_WORK) fail(`results work ${index} needs at least ${MIN_RECALL_PER_WORK} recall samples`);
    if ((!recall.available && recall.sampled !== 0) || recall.correctAndAnswerable > recall.sampled || recall.nonTrivialUsefulBoth > recall.sampled || recall.fabricatedAnswers > recall.sampled) fail(`results work ${index} has impossible recall counts`);
    const anchors = work.anchors;
    integer(anchors.sampled, `results work ${index}.anchors.sampled`, { min: 1 });
    integer(anchors.resolved, `results work ${index}.anchors.resolved`);
    if (anchors.resolved > anchors.sampled) fail(`results work ${index} has impossible anchor counts`);
    assertExactKeys(anchors.navigation, ['kind', 'sampled', 'withinThirtySeconds'], `results work ${index}.anchors.navigation`);
    if (!['audio', 'chapter-only'].includes(anchors.navigation.kind)) fail(`results work ${index}.anchors.navigation.kind is invalid`);
    integer(anchors.navigation.sampled, `results work ${index}.anchors.navigation.sampled`);
    integer(anchors.navigation.withinThirtySeconds, `results work ${index}.anchors.navigation.withinThirtySeconds`);
    if (anchors.navigation.kind === 'audio' && anchors.navigation.sampled < 100) fail(`results work ${index} needs 100 sampled audio seeks`);
    if (anchors.navigation.kind === 'chapter-only' && (anchors.navigation.sampled !== 0 || anchors.navigation.withinThirtySeconds !== 0)) fail(`results work ${index} chapter-only navigation cannot report audio seeks`);
    if (anchors.navigation.withinThirtySeconds > anchors.navigation.sampled) fail(`results work ${index} has impossible audio seek counts`);
    const quotes = work.quotes;
    for (const field of Object.keys(quotes)) integer(quotes[field], `results work ${index}.quotes.${field}`);
    measured.push({ claims, quality: work.quality, recall, anchors, quotes });
  }
  return { measured, provenance: results.provenance };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gate(name, actual, threshold, comparator = '>=') {
  const passed = comparator === '==' ? actual === threshold : actual >= threshold;
  return { name, actual: typeof actual === 'number' ? rounded(actual) : actual, threshold, comparator, passed };
}

function upperGate(name, actual, threshold) {
  return { name, actual, threshold, comparator: '<=', passed: actual <= threshold };
}

function evaluateBookGuideBenchmark({ manifest, calibration, results }) {
  const manifestInfo = validateManifest(manifest);
  const calibrationInfo = validateCalibration(calibration, manifestInfo);
  const resultsInfo = validateResults(results, manifestInfo);
  const works = resultsInfo.measured;
  const totalClaims = works.reduce((sum, work) => sum + work.claims.sampled, 0);
  const fullySupported = works.reduce((sum, work) => sum + work.claims.fullySupported, 0);
  const materialFabrications = works.reduce((sum, work) => sum + work.claims.materialFabrications, 0);
  const recallWorks = works.filter(work => work.recall.available);
  const recallSampled = recallWorks.reduce((sum, work) => sum + work.recall.sampled, 0);
  const recallCorrect = recallWorks.reduce((sum, work) => sum + work.recall.correctAndAnswerable, 0);
  const recallUseful = recallWorks.reduce((sum, work) => sum + work.recall.nonTrivialUsefulBoth, 0);
  const recallFabrications = recallWorks.reduce((sum, work) => sum + work.recall.fabricatedAnswers, 0);
  const resolvedAnchors = works.reduce((sum, work) => sum + work.anchors.resolved, 0);
  const sampledAnchors = works.reduce((sum, work) => sum + work.anchors.sampled, 0);
  const audioWorks = works.filter(work => work.anchors.navigation.kind === 'audio');
  const audioSampled = audioWorks.reduce((sum, work) => sum + work.anchors.navigation.sampled, 0);
  const audioWithin = audioWorks.reduce((sum, work) => sum + work.anchors.navigation.withinThirtySeconds, 0);
  const storedWords = works.reduce((sum, work) => sum + work.quotes.storedSourceWords, 0);
  const maxStoredWords = Math.max(...works.map(work => work.quotes.storedSourceWords));
  const maxExcerpt = Math.max(...works.map(work => work.quotes.maxExcerptWords));
  const maxSequence = Math.max(...works.map(work => work.quotes.maxOutsideExcerptSequenceWords));
  const unsupportedRecall = rate(calibrationInfo.matrix.truePositive, calibrationInfo.matrix.truePositive + calibrationInfo.matrix.falseNegative);
  const unsupportedPrecision = rate(calibrationInfo.matrix.truePositive, calibrationInfo.matrix.truePositive + calibrationInfo.matrix.falsePositive);
  const coverage = average(works.flatMap(work => work.quality.centralIdeaCoverageReviews));
  const usefulness = average(works.flatMap(work => work.quality.usefulnessReviews));
  const gates = [
    gate('corpus.works', manifestInfo.workIds.size, REQUIRED_WORKS),
    gate('corpus.nonfictionShapes', manifestInfo.shapes.size, REQUIRED_NONFICTION_SHAPES),
    gate('claims.fullySupportedRate', rate(fullySupported, totalClaims), MIN_SUPPORTED_RATE),
    { name: 'claims.materialFabrications', actual: materialFabrications, threshold: 0, comparator: '==', passed: materialFabrications === 0 },
    gate('quality.centralIdeaCoverageMean', coverage, MIN_QUALITY_RATING),
    gate('quality.usefulnessMean', usefulness, MIN_QUALITY_RATING),
    gate('recall.correctAndAnswerableRate', rate(recallCorrect, recallSampled), MIN_RECALL_ANSWER_RATE),
    gate('recall.nonTrivialUsefulRate', rate(recallUseful, recallSampled), MIN_RECALL_USEFUL_RATE),
    { name: 'recall.fabricatedAnswers', actual: recallFabrications, threshold: 0, comparator: '==', passed: recallFabrications === 0 },
    { name: 'anchors.exactResolutionRate', actual: rounded(rate(resolvedAnchors, sampledAnchors)), threshold: 1, comparator: '==', passed: resolvedAnchors === sampledAnchors },
    ...(audioWorks.length ? [gate('anchors.audioSeekWithinThirtySecondsRate', rate(audioWithin, audioSampled), MIN_AUDIO_SEEK_RATE)] : []),
    upperGate('quotes.maxStoredSourceWordsPerGuide', maxStoredWords, MAX_STORED_QUOTE_WORDS),
    upperGate('quotes.maxExcerptWords', maxExcerpt, MAX_STORED_EXCERPT_WORDS),
    upperGate('quotes.maxOutsideExcerptSequenceWords', maxSequence, MAX_OUTSIDE_EXCERPT_SEQUENCE_WORDS),
    gate('verifier.calibrationClaims', calibration.claims.length, REQUIRED_CALIBRATION_CLAIMS, '=='),
    gate('verifier.calibrationBooks', calibrationInfo.books, REQUIRED_CALIBRATION_BOOKS),
    gate('verifier.calibrationNonfictionShapes', calibrationInfo.shapes, REQUIRED_NONFICTION_SHAPES),
    gate('verifier.unsupportedRecall', unsupportedRecall, MIN_UNSUPPORTED_RECALL),
    gate('verifier.unsupportedPrecision', unsupportedPrecision, MIN_UNSUPPORTED_PRECISION)
  ];
  const report = {
    schemaVersion: 1,
    privacy: 'aggregate-only:no-book-metadata-paths-text-excerpts-credentials-or-model-responses',
    mode: 'offline',
    passed: gates.every(item => item.passed),
    provenance: {
      generatorModel: resultsInfo.provenance.generatorModel,
      verifierModel: resultsInfo.provenance.verifierModel,
      recipeHash: resultsInfo.provenance.recipeHash,
      extractionVersion: resultsInfo.provenance.extractionVersion,
      normalizationVersion: resultsInfo.provenance.normalizationVersion
    },
    summary: {
      works: manifestInfo.workIds.size,
      nonfictionShapes: manifestInfo.shapes.size,
      sampledClaims: totalClaims,
      sampledRecallQuestions: recallSampled,
      sampledAnchors,
      audioNavigationWorks: audioWorks.length,
      calibrationClaims: calibration.claims.length,
      calibrationBooks: calibrationInfo.books,
      calibrationNonfictionShapes: calibrationInfo.shapes
    },
    gates
  };
  assertNoPrivateOutput(report, 'report');
  return report;
}

function assertLiveProviderAuthorization({ allowLiveProvider, providerConfig }) {
  if (allowLiveProvider && !providerConfig) fail('--allow-live-provider requires --provider-config');
  if (!allowLiveProvider && providerConfig) fail('--provider-config requires --allow-live-provider');
  // This benchmark currently has no network adapter. Keeping this explicit
  // protects a later adapter from making accidental outbound calls.
  return allowLiveProvider ? 'live-authorized-no-adapter' : 'offline';
}

function fingerprintFileContents(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  ALLOWED_SHAPES,
  REQUIRED_WORKS,
  REQUIRED_CALIBRATION_CLAIMS,
  REQUIRED_CALIBRATION_PER_LABEL,
  REQUIRED_CALIBRATION_BOOKS,
  assertLiveProviderAuthorization,
  assertNoPrivateOutput,
  evaluateBookGuideBenchmark,
  fingerprintFileContents,
  validateCalibration,
  validateManifest,
  validateResults
};
