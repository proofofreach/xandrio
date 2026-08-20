function caseMap(report) {
  const mapped = new Map();
  for (const value of report?.cases || []) {
    if (!value?.id) throw new Error('Import benchmark cases require an id');
    if (mapped.has(value.id)) throw new Error(`Duplicate import benchmark case: ${value.id}`);
    mapped.set(value.id, value);
  }
  return mapped;
}

function gate(id, passed, actual, expected) {
  return { id, passed, actual, expected };
}

// A re-segmentation is sometimes the point of a change, so the gate cannot be
// "no structure changed" — that freezes chapter structure permanently. It is
// "no structure changed that the change did not declare". Each accepted case
// records the exact before/after chapter counts, so an accepted entry stops
// matching the moment the real change differs from the declared one.
function acceptedStructureChanges(accepted = []) {
  const byId = new Map();
  for (const entry of accepted || []) {
    if (!entry?.id) throw new Error('Accepted structure changes require a case id');
    if (byId.has(entry.id)) throw new Error(`Duplicate accepted structure change: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  return byId;
}

function structureChangeIsAccepted(entry, before, after) {
  if (!entry) return false;
  return Number(entry.fromChapterCount) === Number(before?.chapterCount) &&
    Number(entry.toChapterCount) === Number(after?.chapterCount);
}

function compareImportBenchmark({ baseline, candidate, acceptedStructureChanges: accepted } = {}) {
  const acceptedById = acceptedStructureChanges(accepted);
  const matchedAcceptances = new Set();
  const baselineCases = caseMap(baseline);
  const candidateCases = caseMap(candidate);
  const ids = new Set([...baselineCases.keys(), ...candidateCases.keys()]);
  const summary = {
    comparedCases: ids.size,
    decisionErrors: 0,
    selectionErrors: 0,
    diagnosticErrors: 0,
    newlyImportable: 0,
    importRegressions: 0,
    invalidAcceptances: 0,
    narrationFailures: 0,
    narrationChanges: 0,
    structureChanges: 0,
    acceptedStructureChanges: 0,
    unaccountedStructureChanges: 0,
    staleStructureAcceptances: 0,
    newDefects: 0,
    remainingUnexpectedNonPrivateDefects: 0,
    remainingPrivateDefects: 0
  };

  for (const id of ids) {
    const before = baselineCases.get(id);
    const after = candidateCases.get(id);
    if (!before || !after) {
      summary.decisionErrors++;
      continue;
    }
    const expectedImportable = after.expectedImportable ?? before.expectedImportable;
    if (Boolean(after.importable) !== Boolean(expectedImportable)) summary.decisionErrors++;
    const expectedSelectedId = after.expectedSelectedId ?? before.expectedSelectedId;
    if (expectedSelectedId && after.selectedId !== expectedSelectedId) summary.selectionErrors++;
    const expectedDiagnosticCodes = after.expectedDiagnosticCodes ?? before.expectedDiagnosticCodes;
    if (Array.isArray(expectedDiagnosticCodes)) {
      const expectedCodes = [...expectedDiagnosticCodes].sort();
      const actualCodes = [...(after.diagnosticCodes || [])].sort();
      if (JSON.stringify(actualCodes) !== JSON.stringify(expectedCodes)) summary.diagnosticErrors++;
    }
    if (expectedImportable && !before.importable && after.importable) summary.newlyImportable++;
    if (expectedImportable && before.importable && !after.importable) summary.importRegressions++;
    if (!expectedImportable && after.importable) summary.invalidAcceptances++;
    if (expectedImportable && !after.narrationValid) summary.narrationFailures++;
    if (
      (after.mustConserveNarration ?? before.mustConserveNarration) &&
      before.normalizedHash &&
      before.normalizedHash !== after.normalizedHash
    ) {
      summary.narrationChanges++;
    }
    const hasStructureIdentity = before.structureKey !== undefined || after.structureKey !== undefined;
    const structureChanged = hasStructureIdentity
      ? before.structureKey !== after.structureKey
      : (
          Number.isInteger(before.chapterCount) &&
          Number.isInteger(after.chapterCount) &&
          before.chapterCount !== after.chapterCount
        );
    if ((after.mustConserveNarration ?? before.mustConserveNarration) && structureChanged) {
      summary.structureChanges++;
      if (structureChangeIsAccepted(acceptedById.get(id), before, after)) {
        summary.acceptedStructureChanges++;
        matchedAcceptances.add(id);
      } else {
        summary.unaccountedStructureChanges++;
      }
    }
    if (Number(after.defectCount || 0) > Number(before.defectCount || 0)) summary.newDefects++;
    const sourceDefects = Math.max(
      0,
      Number(after.sourceDefectCount ?? before.sourceDefectCount) || 0
    );
    const remainingDefects = Math.max(0, (Number(after.defectCount) || 0) - sourceDefects);
    if (id.startsWith('private:')) summary.remainingPrivateDefects += Number(after.defectCount) || 0;
    else summary.remainingUnexpectedNonPrivateDefects += remainingDefects;
  }

  // An acceptance that no longer describes a real change is stale: it would
  // silently pre-approve a future re-cut of that book. Declaring one is as much
  // a failure as failing to declare a real change.
  for (const id of acceptedById.keys()) {
    if (!matchedAcceptances.has(id)) summary.staleStructureAcceptances++;
  }

  const baselineUx = baseline?.ux || {};
  const candidateUx = candidate?.ux || {};
  const gates = [
    gate('candidate-decisions-match-expectations', summary.decisionErrors === 0, summary.decisionErrors, 0),
    gate('candidate-selection-matches-expectations', summary.selectionErrors === 0, summary.selectionErrors, 0),
    gate('candidate-diagnostics-match-expectations', summary.diagnosticErrors === 0, summary.diagnosticErrors, 0),
    gate('no-import-regressions', summary.importRegressions === 0, summary.importRegressions, 0),
    gate('no-invalid-acceptances', summary.invalidAcceptances === 0, summary.invalidAcceptances, 0),
    gate('narration-remains-valid', summary.narrationFailures === 0, summary.narrationFailures, 0),
    gate('narration-is-conserved', summary.narrationChanges === 0, summary.narrationChanges, 0),
    gate(
      'chapter-structure-changes-are-declared',
      summary.unaccountedStructureChanges === 0,
      summary.unaccountedStructureChanges,
      0
    ),
    gate(
      'declared-structure-changes-still-apply',
      summary.staleStructureAcceptances === 0,
      summary.staleStructureAcceptances,
      0
    ),
    gate('no-new-content-defects', summary.newDefects === 0, summary.newDefects, 0),
    gate(
      'synthetic-and-format-cases-have-no-unexpected-defects',
      summary.remainingUnexpectedNonPrivateDefects === 0,
      summary.remainingUnexpectedNonPrivateDefects,
      0
    ),
    gate('importability-strictly-improves', summary.newlyImportable > 0, summary.newlyImportable, 'at least 1'),
    gate(
      'warning-import-auto-opens',
      Number(candidateUx.warningImportManualActions) === 0,
      candidateUx.warningImportManualActions,
      0
    ),
    gate('clean-import-no-detour', Number(candidateUx.cleanImportManualActions) === 0, candidateUx.cleanImportManualActions, 0),
    gate('no-empty-warning-message', candidateUx.emptyWarningMessage === false, candidateUx.emptyWarningMessage, false)
  ];

  return {
    passed: gates.every(value => value.passed),
    summary,
    gates
  };
}

module.exports = { compareImportBenchmark };
