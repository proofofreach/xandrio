const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { evaluateImportVersion } = require('../scripts/lib/import-benchmark-evaluator');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-private-import-benchmark-test-'));
  try {
    const artifactPath = path.join(directory, 'private-title.xbook.json');
    const privateText = 'Private fixture narration remains opaque in the benchmark report. '.repeat(120);
    await fs.writeFile(artifactPath, JSON.stringify({
      _xbookVersion: 1,
      sourceFormat: 'EPUB',
      metadata: { title: 'Private Fixture Title', author: 'Private Fixture Author' },
      chapters: [{ index: 0, title: 'Private Chapter', type: 'chapter', text: privateText }]
    }));
    const report = await evaluateImportVersion({
      versionRoot: path.join(__dirname, '..'),
      privateBooks: [{ id: 'private:opaque-token', path: artifactPath, format: 'epub' }],
      evaluateUx: async () => ({})
    });
    const result = report.cases.find(value => value.id === 'private:opaque-token');
    assert(result);
    assert.equal(result.importable, true);
    assert.equal(result.narrationValid, true);
    assert.equal(result.mustConserveNarration, true);
    const serialized = JSON.stringify(report);
    assert(!serialized.includes('Private Fixture Title'));
    assert(!serialized.includes('Private Fixture Author'));
    assert(!serialized.includes('Private fixture narration'));
    assert(!serialized.includes(artifactPath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  console.log('8 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
