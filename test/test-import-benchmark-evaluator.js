const assert = require('node:assert/strict');
const path = require('node:path');
const corpus = require('./fixtures/import-corpus');
const { evaluateImportVersion } = require('../scripts/lib/import-benchmark-evaluator');

(async () => {
  const report = await evaluateImportVersion({
    versionRoot: path.join(__dirname, '..'),
    policyCases: corpus,
    evaluateUx: async () => ({
      cleanImportManualActions: 0,
      warningImportManualActions: 0,
      emptyWarningMessage: false
    })
  });

  assert.equal(report.cases.length, corpus.length + 1);
  assert.equal(report.cases.find(value => value.id === 'policy:pdf-low-confidence-readable').importable, true);
  assert.equal(report.cases.find(value => value.id === 'policy:pdf-low-confidence-readable').narrationValid, true);
  assert.equal(report.cases.find(value => value.id === 'policy:kindle-drm-protected').importable, false);
  assert.equal(report.cases.find(value => value.id === 'policy:pdf-ocr-required-empty').narrationValid, false);
  assert.deepEqual(
    report.cases.find(value => value.id === 'policy:kindle-drm-protected').diagnosticCodes,
    ['invalid.drm-protected']
  );
  assert.equal(
    report.cases.find(value => value.id === 'candidate:decode-loss-cleaner').selectedId,
    'decode-loss-cleaner'
  );
  assert.equal(report.ux.cleanImportManualActions, 0);
  assert.equal(report.ux.warningImportManualActions, 0);
  assert.equal(report.ux.emptyWarningMessage, false);
  assert(report.cases.every(value => typeof value.normalizedHash === 'string'));
  assert(report.cases.filter(value => value.chapterCount > 0).every(value => typeof value.structureKey === 'string'));
  assert(report.cases.every(value => Number.isInteger(value.defectCount)));

  console.log('11 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
