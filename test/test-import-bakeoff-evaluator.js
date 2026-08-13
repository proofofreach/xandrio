const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { evaluateBakeoffVersion } = require('../scripts/lib/import-bakeoff-evaluator');
const { createSyntheticImportEpub } = require('../scripts/lib/import-benchmark-fixtures');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-bakeoff-evaluator-'));
  try {
    const sourcePath = await createSyntheticImportEpub(root);
    const report = await evaluateBakeoffVersion({
      versionRoot: path.join(__dirname, '..'),
      cases: [{
        id: 'known:1',
        path: sourcePath,
        format: 'epub',
        expectedImportable: true
      }],
      scratchRoot: path.join(root, 'evaluation'),
      evaluateUx: async () => ({
        cleanImportManualActions: 0,
        warningImportManualActions: 0,
        emptyWarningMessage: false
      })
    });
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].id, 'known:1');
    assert.equal(report.cases[0].importable, true);
    assert.equal(report.cases[0].narrationValid, true);
    assert(report.cases[0].normalizedChars > 0);
    assert(report.cases[0].chapterCount > 0);
    assert.equal(typeof report.cases[0].normalizedHash, 'string');
    assert.equal(typeof report.cases[0].structureKey, 'string');
    assert.equal(report.ux.cleanImportManualActions, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('10 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
