// Failure modes: a declared correction is rejected; undeclared text is accepted;
// same-length edits, deletions or reordering pass; reference evidence is absent
// or changed; bounds drift; stale or duplicate declarations pass; malformed
// reference pins pass; evidence leaks private narration or content hashes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const benchmark = require('./benchmark-import-reliability');
const { compareImportBenchmark } = require('../lib/import-benchmark');
const { evaluateImportVersion, runImporterCase } = require('./lib/import-benchmark-evaluator');
const corpus = require('../test/fixtures/import-corpus');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-benchmark-corrections-'));
  const output = path.resolve(__dirname, '../output/playback-processing');
  await fs.mkdir(output, { recursive: true });
  const evidence = { passed: false, scenarios: [] };
  const clone = value => JSON.parse(JSON.stringify(value));
  try {
    // This published pre-correction revision is available to public CI. The
    // operator's private release benchmark keeps its original approved baseline.
    const baselineCommit = '559007ae73f2a8fcd3574e19d42732e18aac8e88';
    const baselineRoot = await benchmark.snapshotRevision(baselineCommit, temp, 'baseline');
    const referenceCommit = '1ce734f4f8944382304e69d5625054a6415422a5';
    const referenceRoot = await benchmark.snapshotRevision(referenceCommit, temp, 'reference');
    const options = { policyCases: corpus, evaluateUx: async () => ({ cleanImportManualActions: 0,
      warningImportManualActions: 0, emptyWarningMessage: false }) };
    const baseline = await evaluateImportVersion({ versionRoot: baselineRoot, ...options });
    const reference = await evaluateImportVersion({ versionRoot: referenceRoot, ...options });
    const id = 'policy:epub-oversized-narration';
    const before = baseline.cases.find(value => value.id === id);
    const after = reference.cases.find(value => value.id === id);
    const correction = { id, fromNormalizedChars: before.normalizedChars,
      toNormalizedChars: after.normalizedChars, reason: 'Restore authored EPUB casing without speech substitutions.' };
    assert.notEqual(before.normalizedHash, after.normalizedHash, 'the real historical import must reproduce the casing rewrite');
    const compare = (candidate = reference, declarations = [correction], expected = reference) =>
      compareImportBenchmark({ baseline, candidate, narrationReference: expected, acceptedNarrationChanges: declarations });
    const correctionsPass = result => {
      const gates = result.gates.filter(gate => ['narration-is-conserved', 'declared-narration-corrections-still-apply'].includes(gate.id));
      assert.equal(gates.length, 2, 'both correction gates must be present');
      return gates.every(gate => gate.passed);
    };
    const scenario = (name, fn) => { fn(); evidence.scenarios.push({ name, passed: true }); };
    scenario('undeclared correction stays blocked', () => assert.equal(correctionsPass(compare(reference, [])), false));
    scenario('exact declared source correction passes', () => {
      const result = compare();
      assert.equal(correctionsPass(result), true);
      assert.equal(result.summary.narrationChanges, 1);
      assert.equal(result.summary.acceptedNarrationChanges, 1);
      assert.equal(result.summary.unaccountedNarrationChanges, 0);
    });
    const fixture = corpus.find(value => value.id === 'epub-oversized-narration');
    const parts = require(path.join(referenceRoot, 'lib/chapter-utils')).splitOversizedChapters(clone(fixture.chapters));
    async function corrupt(name, transform) {
      const chapters = clone(parts); transform(chapters);
      const damaged = await runImporterCase({ versionRoot: referenceRoot, id,
        primaryId: 'policy-epub-oversized-narration', format: 'epub',
        chaptersById: { 'policy-epub-oversized-narration': chapters }, expectedImportable: true,
        expectedDiagnosticCodes: fixture.expected.importDiagnosticCodes });
      const candidate = clone(reference);
      candidate.cases = candidate.cases.map(value => value.id === id ? damaged : value);
      scenario(name, () => assert.equal(correctionsPass(compare(candidate)), false));
    }
    await corrupt('same-length replacement is blocked', chapters => { chapters[0].text = chapters[0].text.replace('EPUB', 'DROP'); });
    await corrupt('deleted source is blocked', chapters => { chapters[0].text = chapters[0].text.slice(1); });
    await corrupt('reordered prose is blocked', chapters => { chapters.reverse(); });
    scenario('missing reference is blocked', () => assert.equal(correctionsPass(compare(reference, [correction], {})), false));
    scenario('changed reference hash is blocked', () => {
      const changed = clone(reference); changed.cases.find(value => value.id === id).normalizedHash = 'unreviewed';
      assert.equal(correctionsPass(compare(reference, [correction], changed)), false);
    });
    scenario('changed character bound is blocked', () => assert.equal(correctionsPass(compare(reference,
      [{ ...correction, toNormalizedChars: correction.toNormalizedChars + 1 }])), false));
    scenario('stale correction is blocked', () => {
      const unchanged = clone(reference); unchanged.cases.find(value => value.id === id).normalizedHash = before.normalizedHash;
      assert.equal(correctionsPass(compare(unchanged)), false);
    });
    scenario('absent case declaration is blocked', () => assert.equal(correctionsPass(compare(reference,
      [correction, { ...correction, id: 'private:absent' }])), false));
    scenario('duplicate declarations are rejected', () => assert.throws(() => compare(reference, [correction, correction]), /Duplicate/));
    const configRoot = path.join(temp, 'configuration');
    const configFile = path.join(configRoot, 'test/fixtures/import-narration-corrections.json');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const config = { schemaVersion: 1, referenceCommit, changes: [correction] };
    await fs.writeFile(configFile, JSON.stringify(config));
    const loaded = await benchmark.declaredNarrationCorrections(configRoot);
    scenario('pinned declaration loads from disk', () => assert.deepEqual(loaded, config));
    for (const invalid of [{ ...config, referenceCommit: 'HEAD' }, { ...config, schemaVersion: 2 },
      { ...config, changes: [{ ...correction, reason: '' }] }, { ...config, changes: [{ ...correction, toNormalizedChars: -1 }] }]) {
      await fs.writeFile(configFile, JSON.stringify(invalid));
      await assert.rejects(() => benchmark.declaredNarrationCorrections(configRoot));
      evidence.scenarios.push({ name: 'malformed declaration is rejected', passed: true });
    }
    const result = compare();
    const safe = benchmark.privacySafeReport({ baselineRef: baselineCommit,
      candidateRef: referenceCommit, narrationReferenceRef: referenceCommit, baseline,
      candidate: reference, narrationReference: reference, comparison: result });
    scenario('report distinguishes corrected text without leaking hashes', () => {
      const item = safe.cases.find(value => value.id === id);
      assert.equal(item.narrationConserved, false);
      assert.equal(item.narrationCorrectionAccepted, true);
      assert.equal(item.narrationReferenceConserved, true);
      const serialized = JSON.stringify(safe);
      for (const value of [...baseline.cases, ...reference.cases]) {
        assert(!serialized.includes(value.normalizedHash), 'report must not expose content hashes');
        if (value.structureKey) assert(!serialized.includes(value.structureKey), 'report must not expose structure hashes');
      }
    });
    evidence.passed = true;
    console.log(`PASS ${evidence.scenarios.length} historical-import correction gate scenarios`);
  } finally {
    await fs.writeFile(path.join(output, `${process.env.BENCHMARK_CORRECTIONS_PHASE || 'benchmark-corrections'}.json`), JSON.stringify(evidence, null, 2));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
