const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  assertLiveProviderAuthorization,
  evaluateBookGuideBenchmark
} = require('../scripts/lib/book-guide-evaluation');
const { parseArgs, runBenchmark } = require('../scripts/benchmark-book-guides');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const workId = index => `work-${index.toString(16).padStart(12, '0')}`;
const claimId = index => `claim-${index.toString(16).padStart(12, '0')}`;

function fixture(root) {
  const works = Array.from({ length: 12 }, (_, index) => ({
    id: workId(index + 1),
    localPath: path.join(root, `work-${index + 1}.txt`),
    sourceFingerprint: hash(`local fixture ${index + 1}`),
    language: 'en',
    nonfictionShape: ['prescriptive', 'argumentative', 'historical', 'biographical', 'narrative', 'technical'][index % 6],
    rights: { basis: index % 2 ? 'licensed' : 'public-domain', attested: true }
  }));
  const calibration = {
    schemaVersion: 1,
    claims: Array.from({ length: 200 }, (_, index) => ({
      id: claimId(index + 1),
      bookId: works[index % 6].id,
      label: index < 100 ? 'supported' : 'unsupported',
      verifierVerdict: index === 199 ? 'supported' : (index < 100 ? 'supported' : 'unsupported')
    }))
  };
  const results = {
    schemaVersion: 1,
    provenance: {
      generatorModel: 'ppq:deepseek-v4-flash-0731',
      verifierModel: 'ppq:glm-5.2',
      recipeHash: hash('recipe'),
      extractionVersion: '1',
      normalizationVersion: '1'
    },
    works: works.map((work, index) => ({
      bookId: work.id,
      sourceFingerprint: work.sourceFingerprint,
      claims: { sampled: 20, fullySupported: 19, materialFabrications: 0 },
      quality: { centralIdeaCoverageReviews: [4, 5], usefulnessReviews: [4, 4] },
      recall: { available: true, sampled: 8, correctAndAnswerable: 8, nonTrivialUsefulBoth: 7, fabricatedAnswers: 0 },
      anchors: {
        sampled: 20,
        resolved: 20,
        navigation: index % 2 ? { kind: 'chapter-only', sampled: 0, withinThirtySeconds: 0 } : { kind: 'audio', sampled: 100, withinThirtySeconds: 90 }
      },
      quotes: { storedSourceWords: 12, maxExcerptWords: 12, maxOutsideExcerptSequenceWords: 11 }
    }))
  };
  return { manifest: { schemaVersion: 1, works }, calibration, results };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-book-guides-'));
  try {
    const values = fixture(root);
    await Promise.all(values.manifest.works.map((work, index) => fs.writeFile(work.localPath, `local fixture ${index + 1}`)));

    const report = evaluateBookGuideBenchmark(values);
    assert.equal(report.passed, true);
    assert.equal(report.mode, 'offline');
    assert.equal(report.summary.works, 12);
    assert.equal(report.gates.find(gate => gate.name === 'verifier.unsupportedRecall').passed, true);
    assert(!JSON.stringify(report).includes(root));

    const privateResults = structuredClone(values.results);
    privateResults.works[0].title = 'must never be accepted';
    assert.throws(() => evaluateBookGuideBenchmark({ ...values, results: privateResults }), /not allowed|private/);

    const malformedCalibration = structuredClone(values.calibration);
    malformedCalibration.claims.pop();
    assert.throws(() => evaluateBookGuideBenchmark({ ...values, calibration: malformedCalibration }), /exactly 200/);

    const brokenAnchorResults = structuredClone(values.results);
    brokenAnchorResults.works[0].anchors.resolved = 19;
    assert.equal(evaluateBookGuideBenchmark({ ...values, results: brokenAnchorResults }).passed, false);

    const perGuideQuoteResults = structuredClone(values.results);
    for (const work of perGuideQuoteResults.works) work.quotes.storedSourceWords = 20;
    assert.equal(evaluateBookGuideBenchmark({ ...values, results: perGuideQuoteResults }).passed, true);

    assert.equal(assertLiveProviderAuthorization({ allowLiveProvider: false, providerConfig: '' }), 'offline');
    assert.throws(() => assertLiveProviderAuthorization({ allowLiveProvider: true, providerConfig: '' }), /provider-config/);
    assert.throws(() => parseArgs(['node', 'benchmark-book-guides.js', '--manifest', 'a', '--calibration', 'b', '--results', 'c', '--provider-config', 'd']), /allow-live-provider/);

    const manifestPath = path.join(root, 'manifest.json');
    const calibrationPath = path.join(root, 'calibration.json');
    const resultsPath = path.join(root, 'results.json');
    await Promise.all([
      fs.writeFile(manifestPath, JSON.stringify(values.manifest)),
      fs.writeFile(calibrationPath, JSON.stringify(values.calibration)),
      fs.writeFile(resultsPath, JSON.stringify(values.results))
    ]);
    const cliReport = await runBenchmark({ manifest: manifestPath, calibration: calibrationPath, results: resultsPath, output: '', allowLiveProvider: false, providerConfig: '' });
    assert.equal(cliReport.passed, true);

    await fs.writeFile(values.manifest.works[0].localPath, 'substituted fixture');
    await assert.rejects(
      runBenchmark({ manifest: manifestPath, calibration: calibrationPath, results: resultsPath, output: '', allowLiveProvider: false, providerConfig: '' }),
      /unavailable/
    );

    console.log('12 passed, 0 failed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
