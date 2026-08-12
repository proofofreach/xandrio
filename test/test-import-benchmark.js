const assert = require('node:assert/strict');
const { compareImportBenchmark } = require('../lib/import-benchmark');

function run(overrides = {}) {
  const baseline = {
    cases: [
      {
        id: 'readable-low-confidence',
        expectedImportable: true,
        expectedSelectedId: 'cleaner',
        selectedId: 'primary',
        expectedDiagnosticCodes: ['structure.low-confidence'],
        diagnosticCodes: ['structure.low-confidence'],
        mustConserveNarration: true,
        importable: false,
        narrationValid: true,
        normalizedHash: 'same-text',
        chapterCount: 2,
        structureKey: 'structure-low-confidence',
        defectCount: 0
      },
      {
        id: 'authored-epub',
        expectedImportable: true,
        mustConserveNarration: true,
        importable: true,
        narrationValid: true,
        normalizedHash: 'authored-text',
        chapterCount: 3,
        structureKey: 'structure-authored',
        defectCount: 0
      },
      {
        id: 'drm-protected',
        expectedImportable: false,
        importable: false,
        narrationValid: false,
        normalizedHash: 'empty',
        chapterCount: 0,
        structureKey: null,
        defectCount: 0
      }
    ],
    ux: {
      cleanImportManualActions: 0,
      warningImportManualActions: 1,
      emptyWarningMessage: false
    }
  };
  const candidate = {
    cases: [
      {
        id: 'readable-low-confidence',
        expectedImportable: true,
        expectedSelectedId: 'cleaner',
        selectedId: 'cleaner',
        expectedDiagnosticCodes: ['structure.low-confidence'],
        diagnosticCodes: ['structure.low-confidence'],
        mustConserveNarration: true,
        importable: true,
        narrationValid: true,
        normalizedHash: 'same-text',
        chapterCount: 2,
        structureKey: 'structure-low-confidence',
        defectCount: 0
      },
      {
        id: 'authored-epub',
        expectedImportable: true,
        mustConserveNarration: true,
        importable: true,
        narrationValid: true,
        normalizedHash: 'authored-text',
        chapterCount: 3,
        structureKey: 'structure-authored',
        defectCount: 0
      },
      {
        id: 'drm-protected',
        expectedImportable: false,
        importable: false,
        narrationValid: false,
        normalizedHash: 'empty',
        chapterCount: 0,
        structureKey: null,
        defectCount: 0
      }
    ],
    ux: {
      cleanImportManualActions: 0,
      warningImportManualActions: 0,
      emptyWarningMessage: false
    }
  };
  return compareImportBenchmark({
    baseline: overrides.baseline || baseline,
    candidate: overrides.candidate || candidate
  });
}

const improvement = run();
assert.equal(improvement.passed, true);
assert.equal(improvement.summary.newlyImportable, 1);
assert.equal(improvement.summary.importRegressions, 0);
assert.equal(improvement.summary.narrationChanges, 0);
assert.equal(improvement.summary.structureChanges, 0);
assert.equal(improvement.summary.selectionErrors, 0);
assert.equal(improvement.summary.diagnosticErrors, 0);
assert.equal(improvement.summary.remainingUnexpectedNonPrivateDefects, 0);
assert(improvement.gates.every(gate => gate.passed));

const alreadyAutomatic = run({
  baseline: {
    ...{
      cases: [
        {
          id: 'readable-low-confidence', expectedImportable: true, mustConserveNarration: true,
          importable: false, narrationValid: true, normalizedHash: 'same-text', chapterCount: 2,
          structureKey: 'structure-low-confidence', defectCount: 0
        },
        {
          id: 'authored-epub', expectedImportable: true, mustConserveNarration: true,
          importable: true, narrationValid: true, normalizedHash: 'authored-text', chapterCount: 3,
          structureKey: 'structure-authored', defectCount: 0
        },
        {
          id: 'drm-protected', expectedImportable: false, importable: false, narrationValid: false,
          normalizedHash: 'empty', chapterCount: 0, structureKey: null, defectCount: 0
        }
      ],
      ux: { cleanImportManualActions: 0, warningImportManualActions: 0, emptyWarningMessage: false }
    }
  }
});
assert.equal(
  alreadyAutomatic.gates.find(gate => gate.id === 'warning-import-auto-opens').passed,
  true,
  'a warning import passes when both revisions already auto-open it'
);

const regressionCandidate = {
  cases: [
    {
      id: 'readable-low-confidence',
      expectedImportable: true,
      selectedId: 'primary',
      diagnosticCodes: [],
      mustConserveNarration: true,
      importable: true,
      narrationValid: true,
      normalizedHash: 'changed-text',
      chapterCount: 2,
      structureKey: 'changed-structure',
      defectCount: 1
    },
    {
      id: 'authored-epub',
      expectedImportable: true,
      mustConserveNarration: true,
      importable: false,
      narrationValid: false,
      normalizedHash: 'authored-text',
      chapterCount: 3,
      structureKey: 'structure-authored',
      defectCount: 0
    },
    {
      id: 'drm-protected',
      expectedImportable: false,
      importable: true,
      narrationValid: false,
      normalizedHash: 'empty',
      chapterCount: 0,
      structureKey: null,
      defectCount: 0
    }
  ],
  ux: {
    cleanImportManualActions: 0,
    warningImportManualActions: 1,
    emptyWarningMessage: true
  }
};
const regression = run({ candidate: regressionCandidate });
assert.equal(regression.passed, false);
assert.equal(regression.summary.importRegressions, 1);
assert.equal(regression.summary.invalidAcceptances, 1);
assert.equal(regression.summary.narrationChanges, 1);
assert.equal(regression.summary.structureChanges, 1);
assert.equal(regression.summary.newDefects, 1);
assert.equal(regression.summary.selectionErrors, 1);
assert.equal(regression.summary.diagnosticErrors, 1);
assert.equal(regression.summary.remainingUnexpectedNonPrivateDefects, 1);
assert(regression.gates.some(gate => gate.id === 'warning-import-auto-opens' && !gate.passed));

console.log('15 passed, 0 failed');
