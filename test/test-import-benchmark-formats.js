const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { evaluateImportVersion } = require('../scripts/lib/import-benchmark-evaluator');
const { createSyntheticImportEpub } = require('../scripts/lib/import-benchmark-fixtures');

(async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-import-benchmark-test-'));
  try {
    const epubPath = await createSyntheticImportEpub(temporaryDirectory);
    const report = await evaluateImportVersion({
      versionRoot: path.join(__dirname, '..'),
      formatFixtures: { epubPath },
      evaluateUx: async () => ({})
    });
    const formats = report.cases.filter(value => value.id.startsWith('format:'));
    assert.deepEqual(formats.map(value => value.id), [
      'format:epub-authored',
      'format:pdf-source-document',
      'format:kindle-container'
    ]);
    assert(formats.every(value => value.importable));
    assert(formats.every(value => value.narrationValid));
    assert(formats.every(value => value.defectCount === 0));
    assert(formats.every(value => value.normalizedChars > 10_000));
    assert(formats.every(value => value.chapterCount >= 2));
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log('6 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
