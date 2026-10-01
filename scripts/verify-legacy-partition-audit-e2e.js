#!/usr/bin/env node
'use strict';

// Failure modes recorded before the detector implementation:
// - A historical speech rewrite is missed, or a same-length/unrelated edit is
//   incorrectly called a proven historical rewrite.
// - Missing/reordered parts or changed source identities pass a whole-text check.
// - Missing/malformed source, cache, or changed transformation code is trusted.
// - An audit migrates a cache, changes reading state/audio, or makes a network call.
// - A report overwrites library data, follows a symlink into it, or leaks paths,
//   private metadata, source excerpts, or content hashes.
// These are synthetic regression fixtures in valid EPUB containers, not real-book coverage.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');
const { createSyntheticImportEpub } = require('./lib/import-benchmark-fixtures');
const { extractChapters } = require('../lib/chapter-extraction');
const { splitOversizedChapters, normalizeChapterSequence } = require('../lib/chapter-utils');

const ROOT = path.resolve(__dirname, '..');
const HISTORICAL_REVISION = '6cc4d30e5cd445020aa45351c276720bd6afee95';
const CLI = path.join(ROOT, 'scripts/audit-legacy-partition.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

// The oracle is the actual immutable historical implementation and its relative
// dependencies, loaded from this trusted repository. It does not call or mirror
// the detector's reconstruction code. Package/native imports use installed deps.
function historicalModule(relativePath, loaded = new Map()) {
  if (loaded.has(relativePath)) return loaded.get(relativePath).exports;
  const source = execFileSync('git', ['show', `${HISTORICAL_REVISION}:${relativePath}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  const filename = path.join(ROOT, relativePath);
  const instance = new Module(filename);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.set(relativePath, instance);
  const packageRequire = instance.require.bind(instance);
  instance.require = specifier => {
    if (!specifier.startsWith('.')) return packageRequire(specifier);
    let dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
    if (!path.posix.extname(dependency)) dependency += '.js';
    assert(dependency.startsWith('lib/'), 'historical oracle must remain inside the reviewed library');
    return historicalModule(dependency, loaded);
  };
  instance._compile(source, filename);
  return instance.exports;
}

async function treeSnapshot(directory, prefix = '') {
  const result = {};
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, item.name);
    const filename = path.join(directory, item.name);
    const stat = await fs.lstat(filename);
    if (item.isDirectory()) {
      result[relative] = { directory: true, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      Object.assign(result, await treeSnapshot(filename, relative));
    }
    else if (item.isSymbolicLink()) result[relative] = { symlink: await fs.readlink(filename) };
    else result[relative] = { bytes: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      sha256: hash(await fs.readFile(filename)) };
  }
  return result;
}

(async () => {
  const artifactDirectory = path.join(ROOT, 'output/playback-processing');
  await fs.mkdir(artifactDirectory, { recursive: true });
  const phase = process.env.LEGACY_PARTITION_AUDIT_PHASE || 'verification';
  assert(/^[a-z0-9-]+$/.test(phase), 'invalid evidence phase');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-legacy-partition-audit-'));
  const library = path.join(temporary, 'library');
  const data = path.join(library, 'data');
  const cache = path.join(library, 'cache');
  const reports = path.join(temporary, 'reports');
  const report = { passed: false, scope: 'CLI E2E with synthetic EPUBs and real persisted caches',
    historicalRevision: HISTORICAL_REVISION, cases: [] };
  let sequence = 0;
  async function scenario(name, check) {
    const before = await treeSnapshot(library);
    try {
      const evidence = await check();
      assert.deepEqual(await treeSnapshot(library), before, 'all library, cache, position, bookmark and audio bytes must remain unchanged');
      report.cases.push({ name, passed: true, libraryBytesUnchanged: true, ...evidence });
      console.log(`PASS ${name}`);
    } catch (error) {
      const unchanged = JSON.stringify(await treeSnapshot(library)) === JSON.stringify(before);
      report.cases.push({ name, passed: false, libraryBytesUnchanged: unchanged,
        error: String(error.message).replaceAll(temporary, '<temporary>').slice(0, 600) });
      console.log(`FAIL ${name}`);
    }
  }
  try {
    await fs.mkdir(data, { recursive: true });
    await fs.mkdir(cache, { recursive: true });
    await fs.mkdir(reports, { recursive: true });
    const fixtureDirectory = path.join(temporary, 'fixture');
    await fs.mkdir(fixtureDirectory);
    const source = await createSyntheticImportEpub(fixtureDirectory);
    const paragraphs = Array.from({ length: 2600 }, (_, index) =>
      `<p>Passage ${index}: Journal no. 8, the 21st runner saved $12.50 while JOYCE watched. Source evidence remains intact.</p>`).join('\n');
    await fs.writeFile(path.join(fixtureDirectory, 'epub-source/OEBPS/chapter-1.xhtml'),
      `<html><body><h1>Chapter 1</h1>${paragraphs}</body></html>`);
    execFileSync('zip', ['-q', source, 'OEBPS/chapter-1.xhtml'], { cwd: path.join(fixtureDirectory, 'epub-source') });
    const raw = await extractChapters(source);
    const historical = historicalModule('lib/chapters/partitioning.js');
    const legacy = historical.normalizeChapterSequence(historical.splitOversizedChapters(clone(raw)), { sourceFormat: 'epub' });
    const current = normalizeChapterSequence(splitOversizedChapters(clone(raw)), { sourceFormat: 'epub' });
    const partIndexes = legacy.flatMap((chapter, index) => chapter.splitFromOversizedChapter ? [index] : []);
    assert(partIndexes.length >= 3, 'the historical oracle must produce at least three real persisted parts');
    assert.notEqual(legacy.map(chapter => chapter.text).join(' '), current.map(chapter => chapter.text).join(' '));
    const expected = new Map();
    const books = {};
    async function addCase(id, chapters, classification, options = {}) {
      const filename = path.join(cache, `${id}.epub`);
      if (!options.missingSource) {
        if (options.malformedSource) await fs.writeFile(filename, 'not a valid EPUB');
        else await fs.copyFile(source, filename);
      }
      await fs.writeFile(filename.replace(/\.epub$/, '.chapters.json'), options.malformedCache ? '{broken' :
        JSON.stringify({ _cacheVersion: 31, chapters }));
      books[id] = { id, path: filename, title: `PRIVATE TITLE ${id}`, author: 'PRIVATE AUTHOR' };
      expected.set(id, classification);
    }
    await addCase('known-legacy', legacy, 'known-legacy-rewrite');
    await addCase('source-preserved', current, 'source-preserved');
    const replaced = clone(legacy);
    const originalLength = replaced[partIndexes[0]].text.length;
    replaced[partIndexes[0]].text = replaced[partIndexes[0]].text.replace('Joyce', 'Josie');
    assert.notEqual(replaced[partIndexes[0]].text, legacy[partIndexes[0]].text);
    assert.equal(replaced[partIndexes[0]].text.length, originalLength);
    await addCase('same-length-replacement', replaced, 'unexplained-mismatch');
    const missing = clone(legacy); missing.splice(partIndexes[1], 1);
    missing.forEach((chapter, index) => { chapter.index = index; });
    await addCase('missing-part', missing, 'unexplained-mismatch');
    const reordered = clone(legacy);
    [reordered[partIndexes[0]], reordered[partIndexes[1]]] = [reordered[partIndexes[1]], reordered[partIndexes[0]]];
    reordered.forEach((chapter, index) => { chapter.index = index; });
    await addCase('reordered-parts', reordered, 'unexplained-mismatch');
    const identity = clone(legacy); identity[partIndexes[0]].sourceChapterIndex += 1;
    await addCase('changed-identity', identity, 'unexplained-mismatch');
    const numbering = clone(legacy); numbering[partIndexes[0]].splitPartCount += 1;
    await addCase('changed-part-count', numbering, 'unexplained-mismatch');
    await addCase('missing-source', legacy, 'source-unavailable', { missingSource: true });
    await addCase('malformed-source', legacy, 'source-unavailable', { malformedSource: true });
    await addCase('malformed-cache', legacy, 'unexplained-mismatch', { malformedCache: true });
    await fs.writeFile(path.join(data, 'books.json'), JSON.stringify(books));
    await fs.writeFile(path.join(data, 'positions.json'), JSON.stringify({ users: { reader: {
      'known-legacy': { chapterIndex: 1, timestamp: 57.5, characterOffset: 912, positionApproximate: true }
    } } }));
    await fs.writeFile(path.join(data, 'bookmarks.json'), JSON.stringify({ users: { reader: {
      'known-legacy': [{ id: 'bookmark-1', chapterIndex: 2, timestamp: 19, note: 'PRIVATE BOOKMARK' }]
    } } }));
    await fs.writeFile(path.join(cache, 'known-legacy_ch1.mp3'), Buffer.from('existing-audio-bytes'));
    await fs.writeFile(path.join(cache, 'known-legacy_ch1.mp3.narration-artifact.json'), '{"version":1,"fingerprint":"existing"}');

    const guardPath = path.join(temporary, 'network-guard.cjs');
    await fs.writeFile(guardPath, `
const deny = () => { throw new Error('E2E_NETWORK_FORBIDDEN'); };
globalThis.fetch = deny;
for (const name of ['http','https']) { const module = require('node:'+name); module.request = deny; module.get = deny; }
const net = require('node:net'); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
require('node:tls').connect = deny; require('node:dgram').createSocket = deny;
`);
    const token = id => hash(`xandrio-legacy-partition-audit-v1:${id}`).slice(0, 12);
    const baseArguments = ['--data-dir', data];
    function run(output, cli = CLI) {
      return spawnSync(process.execPath, ['--require', guardPath, cli, ...baseArguments, '--output', output], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '' }
      });
    }
    for (const [id, classification] of expected) {
      await scenario(`classifies ${id}`, async () => {
        const destination = path.join(reports, `case-${sequence++}.json`);
        const execution = run(destination);
        assert.equal(execution.status, 0, `CLI must finish the audit (actual exit ${execution.status})`);
        const evidence = JSON.parse(await fs.readFile(destination, 'utf8'));
        const row = evidence.records.find(record => record.id === token(id));
        assert(row, 'opaque case must be present in the report');
        assert.equal(row.classification, classification);
        assert.equal(evidence.transformSupported, true);
        return { classification, networkBlockedDuringRun: true };
      });
    }
    await scenario('report and console contain only opaque source references', async () => {
      const destination = path.join(reports, `privacy-${sequence++}.json`);
      const execution = run(destination);
      assert.equal(execution.status, 0, 'CLI must finish the audit');
      const contents = await fs.readFile(destination, 'utf8');
      const serialized = `${contents}\n${execution.stdout}\n${execution.stderr}`;
      for (const secret of [temporary, 'PRIVATE TITLE', 'PRIVATE AUTHOR', 'PRIVATE BOOKMARK', 'Journal no. 8', 'Joyce', 'Passage 0']) {
        assert(!serialized.includes(secret), 'report and logs must omit paths, metadata, notes and prose');
      }
      assert(!/[a-f0-9]{64}/i.test(serialized), 'report must omit content hashes');
      const evidence = JSON.parse(contents);
      assert(evidence.records.every(row => /^[a-f0-9]{12}$/.test(row.id)), 'record identifiers must be opaque');
      return { privateContentOmitted: true };
    });

    const directoryLink = path.join(temporary, 'cache-link');
    await fs.symlink(cache, directoryLink);
    const dataLink = path.join(temporary, 'data-link');
    await fs.symlink(data, dataLink);
    const fileLink = path.join(temporary, 'audio-link.json');
    await fs.symlink(path.join(cache, 'known-legacy_ch1.mp3'), fileLink);
    const destinations = [
      ['library directory', path.join(data, 'report.json')],
      ['source directory', path.join(cache, 'new/report.json')],
      ['source file', books['known-legacy'].path],
      ['position store', path.join(data, 'positions.json')],
      ['bookmark store', path.join(data, 'bookmarks.json')],
      ['audio file', path.join(cache, 'known-legacy_ch1.mp3')],
      ['source directory symlink', path.join(directoryLink, 'report.json')],
      ['library directory symlink', path.join(dataLink, 'report.json')],
      ['audio file symlink', fileLink]
    ];
    for (const [label, destination] of destinations) {
      await scenario(`refuses report output into ${label}`, async () => {
        const execution = run(destination);
        assert.equal(execution.status, 2, 'unsafe report output must be refused before extraction');
        assert(execution.stderr.includes('AUDIT_OUTPUT_UNSAFE'), 'CLI must identify the output refusal without exposing paths');
        return { outputRefused: true };
      });
    }
    await scenario('refuses to overwrite an existing report', async () => {
      const destination = path.join(reports, 'existing.json');
      await fs.writeFile(destination, 'previous report');
      const execution = run(destination);
      assert.equal(execution.status, 2, 'existing reports must not be overwritten');
      assert.equal(await fs.readFile(destination, 'utf8'), 'previous report');
      return { previousEvidenceRetained: true };
    });

    await scenario('changed transformation dependency fails closed', async () => {
      const shadow = path.join(temporary, 'shadow');
      await fs.mkdir(path.join(shadow, 'scripts'), { recursive: true });
      await fs.cp(path.join(ROOT, 'lib'), path.join(shadow, 'lib'), { recursive: true });
      await fs.symlink(path.join(ROOT, 'node_modules'), path.join(shadow, 'node_modules'));
      await fs.copyFile(CLI, path.join(shadow, 'scripts/audit-legacy-partition.js')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.appendFile(path.join(shadow, 'lib/tts-number-words.js'), '\n// Deliberate E2E dependency drift.\n');
      const destination = path.join(reports, 'unsupported-transform.json');
      const execution = run(destination, path.join(shadow, 'scripts/audit-legacy-partition.js'));
      assert.equal(execution.status, 2, 'an unsupported transformation must be incomplete and fail closed');
      const evidence = JSON.parse(await fs.readFile(destination, 'utf8'));
      assert.equal(evidence.transformSupported, false);
      assert(evidence.records.length > 0 && evidence.records.every(row => row.classification === 'unsupported-transform'));
      return { transformationDriftRefused: true };
    });
    report.passed = report.cases.every(result => result.passed);
  } finally {
    await fs.writeFile(path.join(artifactDirectory, `legacy-partition-audit-${phase}.json`), JSON.stringify(report, null, 2));
    await fs.rm(temporary, { recursive: true, force: true });
  }
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
