#!/usr/bin/env node
'use strict';

// Failure modes established before the runner: source checksum/provenance drift,
// missing sources, altered punctuation/diacritics/joiners, missing/reordered
// passages, flattened verse despite normalized equality, duplicate notes,
// and a scanned-page reference assigned to the wrong page. No empty/partial
// run may claim success. The CLI must produce a repeatable evidence artifact.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'output/playback-processing');
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-real-corpus-gates-'));
  const frozen = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/processing-real-corpus.json'), 'utf8'));
  const results = [];
  async function run(name, id, modify, expectedGate) {
    const manifest = structuredClone(frozen);
    modify(manifest.cases.find(row => row.id === id), manifest);
    const manifestPath = path.join(temporary, `${name}.manifest.json`);
    const reportPath = path.join(temporary, `${name}.report.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    try {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/benchmark-real-processing.js'),
        '--manifest', manifestPath, '--case', id, '--output', reportPath], { cwd: root, encoding: 'utf8', timeout: 120000 });
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      assert.equal(report.externalCalls, 0);
      if (!expectedGate) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(report.passed, true);
        assert.equal(report.cases.length, 1);
        assert(report.cases[0].checks.every(check => check.passed));
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(report.passed, false);
        const failures = [...(report.checks || []), ...report.cases.flatMap(row => row.checks || [])].filter(check => !check.passed);
        assert(failures.some(check => check.id === expectedGate), `Expected failed gate ${expectedGate}`);
      }
      results.push({ name, passed: true, expectedGate: expectedGate || 'all-pass', report });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
  async function protectedOutput(name, filename, extraArgs = []) {
    const sentinel = Buffer.from('Existing source or state must never be overwritten.');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, sentinel, { flag: 'wx' });
    try {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/benchmark-real-processing.js'),
        '--case', 'kafka-de', '--output', filename, ...extraArgs], { cwd: root, encoding: 'utf8', timeout: 120000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /REPORT_OUTPUT_UNSAFE/);
      assert.deepEqual(await fs.readFile(filename), sentinel);
      results.push({ name, passed: true, protectedBytesUnchanged: true });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
  async function protectedNewOutput(name, filename, extraArgs = []) {
    try {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/benchmark-real-processing.js'),
        '--case', 'kafka-de', '--output', filename, ...extraArgs], { cwd: root, encoding: 'utf8', timeout: 120000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /REPORT_OUTPUT_UNSAFE/);
      await assert.rejects(fs.access(filename), { code: 'ENOENT' });
      results.push({ name, passed: true, protectedDestinationAbsent: true });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
  try {
    await run('clean-source-and-persisted-roundtrip', 'kafka-de', () => {}, null);
    await run('source-checksum-drift', 'kafka-de', row => { row.sourceSha256 = '0'.repeat(64); }, 'source-checksum');
    await run('missing-source', 'kafka-de', row => { row.source = 'data/benchmarks/processing-real/absent.epub'; }, 'source-available');
    await run('missing-provenance', 'kafka-de', row => { delete row.sourceUrl; }, 'manifest-valid');
    await run('changed-punctuation', 'kafka-de', row => { row.references[0].text = row.references[0].text.replace('erwachte,', 'erwachte;'); }, 'source-reference');
    await run('changed-diacritic', 'kafka-de', row => { row.references[0].text = row.references[0].text.replace('Träumen', 'Traumen'); }, 'source-reference');
    await run('unexpected-joiner', 'kafka-de', row => { row.references[0].text = row.references[0].text.replace('Gregor', 'Gre\u200d gor'); }, 'source-reference');
    await run('missing-passage', 'kafka-de', row => { row.expected.normalizedHash = '0'.repeat(64); }, 'normalized-text');
    await run('reordered-passages', 'kafka-de', row => { row.references.reverse(); }, 'reference-order');
    await run('flattened-verse-with-normalized-equality', 'leaves-en', row => { row.expected.exactTextHash = '0'.repeat(64); }, 'exact-text');
    await run('lost-verse-line', 'leaves-en', row => { row.references[0].lines[1] += ' changed'; }, 'source-reference');
    await run('duplicated-footnote', 'meditations-en', row => { row.references[0].occurrences = 2; }, 'reference-occurrences');
    await run('wrong-scanned-page', 'walden-en', row => { row.references[0].sourceUnit.pageNumber = 10; }, 'source-reference');
    await run('empty-corpus', 'kafka-de', (_row, manifest) => { manifest.cases = []; }, 'manifest-valid');
    await protectedOutput('existing-report-cannot-be-overwritten', path.join(temporary, 'existing-report.json'));
    await protectedOutput('corpus-manifest-cannot-be-overwritten', path.join(temporary, 'protected-manifest.json'),
      ['--manifest', path.join(temporary, 'protected-manifest.json')]);
    await protectedOutput('library-state-cannot-be-overwritten', path.join(temporary, 'source-root/data/books.json'),
      ['--source-root', path.join(temporary, 'source-root')]);
    await protectedNewOutput('new-report-cannot-enter-library', path.join(temporary, 'source-root/data/new-report.json'),
      ['--source-root', path.join(temporary, 'source-root')]);
    await fs.symlink(path.join(temporary, 'source-root/data'), path.join(temporary, 'library-alias'));
    await protectedNewOutput('directory-alias-cannot-enter-library', path.join(temporary, 'library-alias/new-report.json'),
      ['--source-root', path.join(temporary, 'source-root')]);
    const linked = structuredClone(frozen);
    linked.cases[0].source = 'data/linked.epub';
    const foreign = path.join(temporary, 'foreign-library');
    await fs.mkdir(foreign);
    await fs.copyFile(path.join(root, frozen.cases[0].source), path.join(foreign, 'source.epub'));
    await fs.symlink(path.join(foreign, 'source.epub'), path.join(temporary, 'source-root/data/linked.epub'));
    const linkedManifest = path.join(temporary, 'linked-source.manifest.json');
    await fs.writeFile(linkedManifest, JSON.stringify(linked));
    await protectedNewOutput('source-file-alias-protects-its-real-directory', path.join(foreign, 'new-report.json'),
      ['--source-root', path.join(temporary, 'source-root'), '--manifest', linkedManifest]);
  } finally {
    const report = { passed: results.length === 20 && results.every(row => row.passed), cases: results };
    await fs.writeFile(path.join(output, `${process.env.REAL_PROCESSING_GATE_PHASE || 'real-processing-gates'}.json`), JSON.stringify(report, null, 2));
    await fs.rm(temporary, { recursive: true, force: true });
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
