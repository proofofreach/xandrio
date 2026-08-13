const assert = require('node:assert/strict');
const { compareImportBakeoff } = require('../lib/import-bakeoff');

function book(id, overrides = {}) {
  return {
    id,
    expectedImportable: true,
    importable: true,
    narrationValid: true,
    normalizedHash: `${id}-text`,
    normalizedChars: 10_000,
    structureKey: `${id}-structure`,
    chapterCount: 10,
    defectCount: 0,
    ...overrides
  };
}

const ids = [
  ...Array.from({ length: 4 }, (_value, index) => `known:${index + 1}`),
  ...Array.from({ length: 4 }, (_value, index) => `new:${index + 1}`)
];
const baseline = {
  cases: ids.map(id => book(id)),
  ux: { cleanImportManualActions: 0, warningImportManualActions: 1, emptyWarningMessage: false }
};
const candidate = {
  cases: ids.map(id => book(id)),
  ux: { cleanImportManualActions: 0, warningImportManualActions: 0, emptyWarningMessage: false }
};

const comparison = compareImportBakeoff({ baseline, candidate });
assert.equal(comparison.passed, true);
assert.equal(comparison.summary.comparedCases, 8);
assert.equal(comparison.summary.knownCases, 4);
assert.equal(comparison.summary.newCases, 4);
assert.equal(comparison.summary.losses, 0);
assert.equal(comparison.summary.changedCases, 0);
assert(comparison.gates.every(gate => gate.passed));

const importRegression = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'new:1'
      ? { ...value, importable: false, narrationValid: false }
      : value)
  }
});
assert.equal(importRegression.passed, false);
assert.equal(importRegression.summary.importRegressions, 1);
assert.equal(importRegression.summary.losses, 1);

const textLoss = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'known:2'
      ? { ...value, normalizedHash: 'shorter-text', normalizedChars: 9_999 }
      : value)
  }
});
assert.equal(textLoss.passed, false);
assert.equal(textLoss.summary.materialTextLosses, 1);
assert.equal(textLoss.summary.changedCases, 1);
assert.deepEqual(textLoss.differences.map(value => value.id), ['known:2']);

const newDefect = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'new:3'
      ? { ...value, defectCount: 1 }
      : value)
  }
});
assert.equal(newDefect.passed, false);
assert.equal(newDefect.summary.newDefects, 1);
assert.equal(newDefect.summary.losses, 1);

const narrationChange = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'new:2'
      ? { ...value, normalizedHash: 'different-equal-length-text' }
      : value)
  }
});
assert.equal(narrationChange.passed, false);
assert.equal(narrationChange.summary.narrationChanges, 1);
assert.equal(narrationChange.summary.changedCases, 1);

const structureCollapse = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'known:1'
      ? { ...value, structureKey: 'collapsed', chapterCount: 1 }
      : value)
  }
});
assert.equal(structureCollapse.passed, false);
assert.equal(structureCollapse.summary.structureChanges, 1);

const diagnosticRegression = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'new:4'
      ? { ...value, warningCount: 3, errorCount: 2 }
      : value)
  }
});
assert.equal(diagnosticRegression.passed, false);
assert.equal(diagnosticRegression.summary.warningRegressions, 1);
assert.equal(diagnosticRegression.summary.errorRegressions, 1);
assert.deepEqual(diagnosticRegression.differences.map(value => value.id), ['new:4']);

const replacedWarning = compareImportBakeoff({
  baseline: {
    ...baseline,
    cases: baseline.cases.map(value => value.id === 'known:3'
      ? { ...value, warningCount: 1, warningKeys: ['existing-warning'] }
      : value)
  },
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'known:3'
      ? { ...value, warningCount: 1, warningKeys: ['new-serious-warning'] }
      : value)
  }
});
assert.equal(replacedWarning.passed, false);
assert.equal(replacedWarning.summary.warningRegressions, 1);
assert.equal(replacedWarning.differences[0].warningsChanged, true);

const stillRejected = compareImportBakeoff({
  baseline: {
    ...baseline,
    cases: baseline.cases.map(value => value.id === 'known:4'
      ? { ...value, importable: false, narrationValid: false }
      : value)
  },
  candidate: {
    ...candidate,
    cases: candidate.cases.map(value => value.id === 'known:4'
      ? { ...value, importable: false, narrationValid: false }
      : value)
  }
});
assert.equal(stillRejected.passed, false);
assert.equal(stillRejected.summary.candidateFailures, 1);

const uxRegression = compareImportBakeoff({
  baseline,
  candidate: {
    ...candidate,
    ux: { cleanImportManualActions: 1, warningImportManualActions: 2, emptyWarningMessage: true }
  }
});
assert.equal(uxRegression.passed, false);
assert.equal(uxRegression.summary.userActionRegressions, 2);
assert(uxRegression.gates.some(value => value.id === 'no-empty-warning-message' && !value.passed));

console.log('38 passed, 0 failed');
