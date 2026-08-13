const assert = require('node:assert/strict');
const {
  REQUIRED_BASELINE,
  assertPrivateHistoricalManifest,
  parseArgs,
  privacySafeBakeoffReport
} = require('../scripts/benchmark-import-bakeoff');

const parsed = parseArgs([
  'node',
  'benchmark-import-bakeoff.js',
  '--historical-manifest',
  '/tmp/historical.json',
  '--candidate',
  'candidate-sha',
  '--output',
  '/tmp/report.json'
]);
assert.equal(parsed.baseline, REQUIRED_BASELINE);
assert.equal(parsed.historicalManifest, '/tmp/historical.json');
assert.equal(parsed.candidate, 'candidate-sha');
assert.equal(parsed.output, '/tmp/report.json');
assert.throws(
  () => parseArgs(['node', 'script']),
  /historical-manifest is required/
);
assert.throws(
  () => assertPrivateHistoricalManifest('/repo/private.json', '/repo'),
  /outside the repository/
);
assert.doesNotThrow(
  () => assertPrivateHistoricalManifest('/private/tmp/private.json', '/repo')
);
assert.throws(
  () => parseArgs(['node', 'script', '--historical-manifest', '/tmp/a', '--baseline', 'wrong']),
  /baseline must be the approved previous system/
);
assert.throws(
  () => parseArgs(['node', 'script', '--historical-manifest', '/tmp/a', '--candidate', 'WORKTREE']),
  /committed git revision/
);
assert.throws(
  () => parseArgs(['node', 'script', '--historical-manifest']),
  /requires a value/
);

const safe = privacySafeBakeoffReport({
  baselineRef: 'before',
  candidateRef: 'after',
  baseline: {
    cases: [{
      id: 'new:1', path: '/private/book.epub', title: 'Private Title', text: 'private text',
      digest: 'private-source-digest', normalizedHash: 'private-hash',
      structureKey: 'private-structure', normalizedChars: 1000,
      chapterCount: 2, defectCount: 0, importable: true, narrationValid: true
    }],
    ux: { warningImportManualActions: 1 }
  },
  candidate: {
    cases: [{
      id: 'new:1', path: '/private/book.epub', title: 'Private Title', text: 'private text',
      digest: 'private-source-digest', normalizedHash: 'private-hash',
      structureKey: 'private-structure', normalizedChars: 1000,
      chapterCount: 2, defectCount: 0, importable: true, narrationValid: true
    }],
    ux: { warningImportManualActions: 0 }
  },
  comparison: {
    passed: false,
    summary: { changedCases: 1 },
    gates: [],
    differences: [{
      id: 'new:1',
      cohort: 'new',
      narrationChanged: true,
      structureChanged: false,
      defectsChanged: false,
      warningsChanged: false,
      errorsChanged: false,
      baseline: { normalizedChars: 1000, chapterCount: 2, defectCount: 0, warningCount: 0, errorCount: 0 },
      candidate: { normalizedChars: 1000, chapterCount: 2, defectCount: 0, warningCount: 0, errorCount: 0 }
    }]
  }
});
const serialized = JSON.stringify(safe);
for (const secret of [
  '/private/book.epub',
  'Private Title',
  'private text',
  'private-source-digest',
  'private-hash',
  'private-structure'
]) {
  assert(!serialized.includes(secret));
}
assert.equal(safe.differences.length, 1);
assert.equal(safe.differences[0].id, 'new:1');
assert.equal('cases' in safe, false);

console.log('20 passed, 0 failed');
