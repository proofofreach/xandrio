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
  run.baselineFixture = baseline;
  run.candidateFixture = candidate;
  return compareImportBenchmark({
    baseline: overrides.baseline || baseline,
    candidate: overrides.candidate || candidate,
    acceptedStructureChanges: overrides.acceptedStructureChanges
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

// An intentional re-segmentation ships only when the change declares it, and a
// declaration only counts while it still describes what actually happens.
const resegmentedCandidate = JSON.parse(JSON.stringify(run.candidateFixture));
const resegmented = resegmentedCandidate.cases.find(value => value.id === 'authored-epub');
resegmented.chapterCount = 2;
resegmented.structureKey = 'structure-authored-merged';

const undeclared = run({ candidate: resegmentedCandidate });
assert.equal(undeclared.passed, false);
assert.equal(undeclared.summary.structureChanges, 1);
assert.equal(undeclared.summary.unaccountedStructureChanges, 1);
assert(undeclared.gates.some(gate => gate.id === 'chapter-structure-changes-are-declared' && !gate.passed));

const declared = run({
  candidate: resegmentedCandidate,
  acceptedStructureChanges: [{ id: 'authored-epub', fromChapterCount: 3, toChapterCount: 2 }]
});
assert.equal(declared.passed, true);
assert.equal(declared.summary.structureChanges, 1);
assert.equal(declared.summary.acceptedStructureChanges, 1);
assert.equal(declared.summary.unaccountedStructureChanges, 0);

const mismatched = run({
  candidate: resegmentedCandidate,
  acceptedStructureChanges: [{ id: 'authored-epub', fromChapterCount: 3, toChapterCount: 1 }]
});
assert.equal(mismatched.passed, false);
assert.equal(mismatched.summary.unaccountedStructureChanges, 1,
  'a declaration that names the wrong result does not pre-approve a different one');

const stale = run({
  acceptedStructureChanges: [{ id: 'authored-epub', fromChapterCount: 3, toChapterCount: 2 }]
});
assert.equal(stale.passed, false);
assert.equal(stale.summary.staleStructureAcceptances, 1);
assert(stale.gates.some(gate => gate.id === 'declared-structure-changes-still-apply' && !gate.passed));

// A re-cut that leaves the chapter count alone must declare itself as one.
const retypedCandidate = JSON.parse(JSON.stringify(run.candidateFixture));
const retyped = retypedCandidate.cases.find(value => value.id === 'authored-epub');
retyped.structureKey = 'structure-authored-retyped';

const countStableUndeclared = run({ candidate: retypedCandidate });
assert.equal(countStableUndeclared.passed, false);
assert.equal(countStableUndeclared.summary.unaccountedStructureChanges, 1,
  'a boundary change with a stable chapter count is still a structure change');

const countStableVacuous = run({
  candidate: retypedCandidate,
  acceptedStructureChanges: [{ id: 'authored-epub', fromChapterCount: 3, toChapterCount: 3 }]
});
assert.equal(countStableVacuous.passed, false);
assert.equal(countStableVacuous.summary.unaccountedStructureChanges, 1,
  'unchanged counts alone cannot describe a change, so they cannot accept one');

const countStableDeclared = run({
  candidate: retypedCandidate,
  acceptedStructureChanges: [{
    id: 'authored-epub',
    fromChapterCount: 3,
    toChapterCount: 3,
    structureChangedWithoutChapterCount: true
  }]
});
assert.equal(countStableDeclared.passed, true);
assert.equal(countStableDeclared.summary.acceptedStructureChanges, 1);

// A case that must conserve narration but carries no comparable identity is
// unverifiable, not conserved.
const opaqueCandidate = JSON.parse(JSON.stringify(run.candidateFixture));
const opaque = opaqueCandidate.cases.find(value => value.id === 'authored-epub');
delete opaque.structureKey;
delete opaque.chapterCount;
const opaqueBaseline = JSON.parse(JSON.stringify(run.baselineFixture));
const opaqueBefore = opaqueBaseline.cases.find(value => value.id === 'authored-epub');
delete opaqueBefore.structureKey;
delete opaqueBefore.chapterCount;

const uncheckable = run({ baseline: opaqueBaseline, candidate: opaqueCandidate });
assert.equal(uncheckable.passed, false);
assert.equal(uncheckable.summary.uncheckableStructureCases, 1);
assert(uncheckable.gates.some(gate => gate.id === 'chapter-structure-is-checkable' && !gate.passed));

console.log('30 passed, 0 failed');
