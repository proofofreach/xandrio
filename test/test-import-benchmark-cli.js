const assert = require('node:assert/strict');
const {
  parseArgs,
  privacySafeReport,
  REQUIRED_BASELINE,
  assertCandidateSnapshot
} = require('../scripts/benchmark-import-reliability');

const args = parseArgs([
  'node',
  'benchmark-import-reliability.js',
  '--baseline',
  REQUIRED_BASELINE,
  '--candidate',
  'candidate-sha',
  '--private-limit',
  '5',
  '--output',
  '/tmp/report.json'
]);
assert.equal(args.baseline, REQUIRED_BASELINE);
assert.equal(args.candidate, 'candidate-sha');
assert.equal(args.privateLimit, 5);
assert.equal(args.output, '/tmp/report.json');
assert.equal(parseArgs(['node', 'script']).baseline, REQUIRED_BASELINE);
assert.throws(
  () => parseArgs(['node', 'script', '--baseline', 'wrong-baseline']),
  /baseline must be the approved previous system/
);
assert.doesNotThrow(() => assertCandidateSnapshot({
  candidateCommit: 'same', headCommit: 'same', worktreeStatus: ''
}));
assert.throws(() => assertCandidateSnapshot({
  candidateCommit: 'old', headCommit: 'same', worktreeStatus: ''
}), /candidate must resolve to HEAD/);
assert.throws(() => assertCandidateSnapshot({
  candidateCommit: 'same', headCommit: 'same', worktreeStatus: ' M lib/file.js'
}), /worktree must be clean/);
assert.throws(
  () => parseArgs(['node', 'script', '--private-limit', '4']),
  /exactly 5/
);
assert.throws(
  () => parseArgs(['node', 'script', '--candidate', 'WORKTREE']),
  /committed git revision/
);

const safe = privacySafeReport({
  baselineRef: 'before',
  candidateRef: 'after',
  baseline: {
    cases: [{
      id: 'private:opaque', importable: true, narrationValid: true,
      normalizedHash: 'secret-content-hash', normalizedChars: 5000,
      chapterCount: 2, structureKey: 'secret-structure-hash', defectCount: 0
    }],
    ux: { warningImportManualActions: 1 }
  },
  candidate: {
    cases: [{
      id: 'private:opaque', importable: true, narrationValid: true,
      normalizedHash: 'secret-content-hash', normalizedChars: 5000,
      chapterCount: 2, structureKey: 'secret-structure-hash', defectCount: 0
    }],
    ux: { warningImportManualActions: 0 }
  },
  comparison: { passed: true, summary: {}, gates: [] }
});
const serialized = JSON.stringify(safe);
assert(!serialized.includes('secret-content-hash'));
assert(!serialized.includes('secret-structure-hash'));
assert.equal(safe.cases[0].narrationConserved, true);
assert.equal(safe.cases[0].chapterStructureConserved, true);
assert.equal(safe.cases[0].baseline.normalizedChars, 5000);
assert.equal(safe.cases[0].candidate.chapterCount, 2);

console.log('11 passed, 0 failed');
