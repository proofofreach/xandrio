function caseMap(report) {
  const values = new Map();
  for (const value of report?.cases || []) {
    if (!value?.id) throw new Error('Import bake-off cases require an id');
    if (values.has(value.id)) throw new Error(`Duplicate import bake-off case: ${value.id}`);
    values.set(value.id, value);
  }
  return values;
}

function gate(id, passed, actual, expected) {
  return { id, passed, actual, expected };
}

function identityKeys(value, name) {
  return Array.isArray(value?.[name]) ? [...new Set(value[name])].sort() : null;
}

function identitiesChanged(before, after, keysName, countName) {
  const beforeKeys = identityKeys(before, keysName);
  const afterKeys = identityKeys(after, keysName);
  if (beforeKeys || afterKeys) return JSON.stringify(beforeKeys || []) !== JSON.stringify(afterKeys || []);
  return Number(before?.[countName] || 0) !== Number(after?.[countName] || 0);
}

function hasNewIdentity(before, after, keysName, countName) {
  const beforeKeys = identityKeys(before, keysName);
  const afterKeys = identityKeys(after, keysName);
  if (beforeKeys || afterKeys) {
    const known = new Set(beforeKeys || []);
    return (afterKeys || []).some(value => !known.has(value));
  }
  return Number(after?.[countName] || 0) > Number(before?.[countName] || 0);
}

function compareImportBakeoff({ baseline, candidate } = {}) {
  const before = caseMap(baseline);
  const after = caseMap(candidate);
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const baselineUx = baseline?.ux || {};
  const candidateUx = candidate?.ux || {};
  const actionKeys = ['cleanImportManualActions', 'warningImportManualActions'];
  const summary = {
    comparedCases: ids.length,
    knownCases: ids.filter(id => id.startsWith('known:')).length,
    newCases: ids.filter(id => id.startsWith('new:')).length,
    candidateFailures: 0,
    importRegressions: 0,
    importImprovements: 0,
    narrationChanges: 0,
    structureChanges: 0,
    materialTextLosses: 0,
    newDefects: 0,
    warningChanges: 0,
    warningRegressions: 0,
    errorRegressions: 0,
    diagnosticChanges: 0,
    losses: 0,
    changedCases: 0,
    userActionRegressions: actionKeys.filter(key =>
      Number(candidateUx[key] || 0) > Number(baselineUx[key] || 0)
    ).length
  };
  const differences = [];

  for (const id of ids) {
    const baselineCase = before.get(id);
    const candidateCase = after.get(id);
    if (!baselineCase || !candidateCase) {
      summary.losses += 1;
      continue;
    }
    let lost = false;
    if (candidateCase.expectedImportable !== false && (
      !candidateCase.importable || !candidateCase.narrationValid
    )) {
      summary.candidateFailures += 1;
      lost = true;
    }
    if (baselineCase.importable && !candidateCase.importable) {
      summary.importRegressions += 1;
      lost = true;
    }
    if (!baselineCase.importable && candidateCase.importable) summary.importImprovements += 1;
    const importChanged = Boolean(baselineCase.importable) !== Boolean(candidateCase.importable);
    const narrationChanged = baselineCase.normalizedHash !== candidateCase.normalizedHash;
    const structureChanged = baselineCase.structureKey !== candidateCase.structureKey;
    const defectsChanged = Number(baselineCase.defectCount || 0) !== Number(candidateCase.defectCount || 0);
    const warningsChanged = identitiesChanged(
      baselineCase, candidateCase, 'warningKeys', 'warningCount'
    );
    const errorsChanged = identitiesChanged(
      baselineCase, candidateCase, 'errorKeys', 'errorCount'
    );
    const diagnosticsChanged = identitiesChanged(
      baselineCase, candidateCase, 'diagnosticKeys', 'diagnosticCount'
    );
    if (narrationChanged) summary.narrationChanges += 1;
    if (structureChanged) summary.structureChanges += 1;
    if (warningsChanged) summary.warningChanges += 1;
    if (diagnosticsChanged) summary.diagnosticChanges += 1;
    if (
      baselineCase.importable && candidateCase.importable &&
      Number(candidateCase.normalizedChars || 0) < Number(baselineCase.normalizedChars || 0)
    ) {
      summary.materialTextLosses += 1;
      lost = true;
    }
    if (Number(candidateCase.defectCount || 0) > Number(baselineCase.defectCount || 0)) {
      summary.newDefects += 1;
      lost = true;
    }
    if (Number(candidateCase.warningCount || 0) > Number(baselineCase.warningCount || 0)) {
      summary.warningRegressions += 1;
      lost = true;
    }
    if (hasNewIdentity(baselineCase, candidateCase, 'errorKeys', 'errorCount')) {
      summary.errorRegressions += 1;
      lost = true;
    }
    if (
      importChanged || narrationChanged || structureChanged || defectsChanged ||
      warningsChanged || errorsChanged || diagnosticsChanged
    ) {
      summary.changedCases += 1;
      differences.push({
        id,
        cohort: id.split(':')[0],
        importChanged,
        narrationChanged,
        structureChanged,
        defectsChanged,
        warningsChanged,
        errorsChanged,
        diagnosticsChanged,
        baseline: {
          importable: Boolean(baselineCase.importable),
          normalizedChars: Number(baselineCase.normalizedChars || 0),
          chapterCount: Number(baselineCase.chapterCount || 0),
          defectCount: Number(baselineCase.defectCount || 0),
          warningCount: Number(baselineCase.warningCount || 0),
          errorCount: Number(baselineCase.errorCount || 0),
          diagnosticCount: Number(baselineCase.diagnosticCount || 0)
        },
        candidate: {
          importable: Boolean(candidateCase.importable),
          normalizedChars: Number(candidateCase.normalizedChars || 0),
          chapterCount: Number(candidateCase.chapterCount || 0),
          defectCount: Number(candidateCase.defectCount || 0),
          warningCount: Number(candidateCase.warningCount || 0),
          errorCount: Number(candidateCase.errorCount || 0),
          diagnosticCount: Number(candidateCase.diagnosticCount || 0)
        }
      });
    }
    if (lost) summary.losses += 1;
  }

  const gates = [
    gate('exactly-eight-paired-books', summary.comparedCases === 8, summary.comparedCases, 8),
    gate('four-known-books', summary.knownCases === 4, summary.knownCases, 4),
    gate('four-new-books', summary.newCases === 4, summary.newCases, 4),
    gate('candidate-imports-all-eight', summary.candidateFailures === 0, summary.candidateFailures, 0),
    gate('no-import-regressions', summary.importRegressions === 0, summary.importRegressions, 0),
    gate('no-unreviewed-narration-changes', summary.narrationChanges === 0, summary.narrationChanges, 0),
    gate('no-unreviewed-structure-changes', summary.structureChanges === 0, summary.structureChanges, 0),
    gate('no-material-text-loss', summary.materialTextLosses === 0, summary.materialTextLosses, 0),
    gate('no-new-content-defects', summary.newDefects === 0, summary.newDefects, 0),
    gate('no-added-user-warnings', summary.warningRegressions === 0, summary.warningRegressions, 0),
    gate('no-added-errors', summary.errorRegressions === 0, summary.errorRegressions, 0),
    gate('no-extra-user-actions', summary.userActionRegressions === 0, summary.userActionRegressions, 0),
    gate(
      'warning-import-auto-opens',
      Number(candidateUx.warningImportManualActions) === 0,
      candidateUx.warningImportManualActions,
      0
    ),
    gate(
      'clean-import-no-detour',
      Number(candidateUx.cleanImportManualActions) === 0,
      candidateUx.cleanImportManualActions,
      0
    ),
    gate(
      'no-empty-warning-message',
      candidateUx.emptyWarningMessage === false,
      candidateUx.emptyWarningMessage,
      false
    ),
    gate('no-losses', summary.losses === 0, summary.losses, 0)
  ];
  return { passed: gates.every(value => value.passed), summary, gates, differences };
}

module.exports = { compareImportBakeoff };
