#!/usr/bin/env node
'use strict';

// Failure modes, defined before the guard: a partitioner rewrites speech,
// drops/duplicates/reorders prose, returns no chapters, or mutates its input.
// None may publish a chapter cache or poison a retry. Existing XBook extraction,
// playback reads and validation must reject the same faults without rewriting
// the artifact. Legitimate whitespace/NFKC equivalence must remain accepted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSyntheticImportEpub } = require('./lib/import-benchmark-fixtures');
const { createBookDocument } = require('../lib/book-document');
const { createXBookStore } = require('../lib/xbook-store');
const { normalizedNarrationText } = require('../lib/extraction-result');
const { splitOversizedChapters } = require('../lib/chapter-utils');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const quiet = { log() {}, warn() {}, error() {} };
const faults = [
  ['speech-rewrite', chapters => chapters.map(chapter => ({ ...chapter, text: chapter.text.replace(/no\. 8/g, 'Number eight') }))],
  ['same-length-replacement', chapters => chapters.map(chapter => ({ ...chapter, text: chapter.text.replace(/JOYCE/g, 'JOSIE') }))],
  ['missing-prose', chapters => chapters.slice(1)],
  ['duplicate-prose', chapters => [...chapters, chapters[0]]],
  ['reordered-prose', chapters => [...chapters].reverse()],
  ['empty-result', () => []],
  ['boundary-loss', chapters => [{ ...chapters[0], text: chapters.map(chapter => chapter.text).join('') }]],
  ['input-mutation', chapters => { chapters[0].text = 'Lost source prose.'; return chapters; }]
];

(async () => {
  const output = path.resolve(__dirname, '../output/playback-processing');
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-partition-integrity-'));
  const report = { passed: false, scope: 'Real EPUB and MOBI worker parsing, disk chapter cache and real XBook store; partition fault injection only', cases: [] };
  async function scenario(name, verify) {
    try {
      const evidence = await verify();
      report.cases.push({ name, passed: true, ...evidence });
      console.log(`PASS ${name}`);
    } catch (error) {
      report.cases.push({ name, passed: false, error: error.message });
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
  try {
    const source = await createSyntheticImportEpub(temporary);
    const prose = 'Journal 20, no. 8: O’Reilly, café, 21st, $12.50 and JOYCE. ';
    await fs.writeFile(path.join(temporary, 'epub-source/OEBPS/chapter-1.xhtml'),
      `<html><body><h1>Chapter 1</h1><p>${prose.repeat(2200)}</p></body></html>`);
    execFileSync('zip', ['-q', source, 'OEBPS/chapter-1.xhtml'], { cwd: path.join(temporary, 'epub-source') });
    const clean = await createBookDocument({ log: quiet }).extractChapters(source);
    const sourceHash = digest(normalizedNarrationText(clean));
    const store = createXBookStore({ cacheDir: temporary,
      getFileIdentity: async filename => { const stat = await fs.stat(filename); return { mtimeMs: stat.mtimeMs, size: stat.size }; },
      invalidateFileIdentity() {}, getBookFormatFromName: () => 'epub' });
    const { xbookPath } = await store.writeXBookArtifact('integrity', source, { metadata: { title: 'Synthetic partition integrity' }, chapters: clean, originalFormat: 'EPUB' });
    const artifactHash = digest(await fs.readFile(xbookPath));

    for (const [name, fault] of faults) {
      await scenario(`EPUB cache rejects ${name} before publication and permits a clean retry`, async () => {
        const directory = path.join(temporary, name);
        await fs.mkdir(directory);
        const filename = path.join(directory, 'source.epub');
        await fs.copyFile(source, filename);
        let inject = true;
        const doc = createBookDocument({ log: quiet, splitOversizedChapters: chapters => inject ? fault(chapters) : splitOversizedChapters(chapters) });
        await assert.rejects(doc.getChaptersCached(filename), { code: 'CHAPTER_PARTITION_TEXT_MISMATCH' });
        await assert.rejects(fs.access(doc.getChapterCachePath(filename)), { code: 'ENOENT' });
        inject = false;
        const retry = await doc.getChaptersCached(filename);
        assert.equal(digest(normalizedNarrationText(retry)), sourceHash);
        const persisted = JSON.parse(await fs.readFile(doc.getChapterCachePath(filename), 'utf8'));
        assert.equal(digest(normalizedNarrationText(persisted.chapters)), sourceHash);
        return { rejectedBeforePublication: true, cleanRetryHash: sourceHash };
      });
      for (const operation of ['extractChapters', 'getChaptersCached', 'validateBook']) {
        await scenario(`XBook ${operation} rejects ${name} and preserves stored narration`, async () => {
          let inject = true;
          const doc = createBookDocument({ log: quiet, getXBookStore: () => store,
            splitOversizedChapters: chapters => inject ? fault(chapters) : splitOversizedChapters(chapters) });
          if (operation === 'validateBook') {
            const validation = await doc.validateBook(xbookPath);
            assert.equal(validation.valid, false);
            assert(validation.errors.some(message => /partition.*text/i.test(message)));
          } else {
            await assert.rejects(doc[operation](xbookPath), { code: 'CHAPTER_PARTITION_TEXT_MISMATCH' });
          }
          assert.equal(digest(await fs.readFile(xbookPath)), artifactHash);
          inject = false;
          const retry = await doc.getChaptersCached(xbookPath);
          assert.equal(digest(normalizedNarrationText(retry)), sourceHash);
          return { storedArtifactUnchanged: true, cleanRetryHash: sourceHash };
        });
      }
    }
    await scenario('Sequence normalization cannot drop prose after a valid split', async () => {
      const doc = createBookDocument({ log: quiet, normalizeChapterSequence: chapters => chapters.slice(1) });
      await assert.rejects(doc.extractChapters(source), { code: 'CHAPTER_PARTITION_TEXT_MISMATCH' });
      return { rejectedAfterSequenceNormalization: true };
    });
    await scenario('Equivalent whitespace and compatibility Unicode remain accepted', async () => {
      const doc = createBookDocument({ log: quiet, splitOversizedChapters: chapters => splitOversizedChapters(chapters).map(chapter => ({
        ...chapter, text: chapter.text.normalize('NFKC').replace(/ /g, '\n\t')
      })) });
      const extracted = await doc.extractChapters(source);
      assert.equal(digest(normalizedNarrationText(extracted)), sourceHash);
      return { normalizedSourceHash: sourceHash };
    });
    // The real Kindle parser partitions inside its worker before BookDocument
    // sees the chapters. A later snapshot cannot detect those earlier faults.
    const kindleSource = path.resolve(__dirname, '../data/benchmarks/jev-expanded/huck.mobi');
    const kindleFaults = [
      ['speech-rewrite', 'chapters[0].text = "Rewritten narration. " + chapters[0].text'],
      ['same-length-replacement', 'chapters[0].text = "X".repeat(chapters[0].text.length)'],
      ['missing-prose', 'chapters = chapters.slice(1)'],
      ['duplicate-prose', 'chapters = [...chapters, chapters[0]]'],
      ['reordered-prose', 'chapters = [...chapters].reverse()'],
      ['empty-result', 'chapters = []'],
      ['boundary-loss', 'chapters = [{...chapters[0], text: chapters.map(chapter => chapter.text).join("")}]'],
      ['input-mutation', 'chapters[0].text = "Lost source prose."']
    ];
    for (const [name, mutation] of kindleFaults) {
      await scenario(`Real MOBI worker rejects first-partition ${name} before cache publication`, async () => {
        const directory = path.join(temporary, `kindle-${name}`);
        await fs.mkdir(directory);
        const filename = path.join(directory, 'source.mobi');
        await fs.copyFile(kindleSource, filename);
        const preload = path.join(directory, 'partition-fault.cjs');
        await fs.writeFile(preload, `
const { isMainThread } = require('node:worker_threads');
if (!isMainThread) {
  const utils = require(${JSON.stringify(require.resolve('../lib/chapter-utils'))});
  utils.splitOversizedChapters = chapters => { ${mutation}; return chapters; };
}
`);
        const invocation = `
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createBookDocument } = require(${JSON.stringify(require.resolve('../lib/book-document'))});
(async () => {
  const doc = createBookDocument({log: {log(){}, warn(){}, error(){}}});
  await assert.rejects(doc.getChaptersCached(${JSON.stringify(filename)}), error => {
    assert.equal(error.code, 'KINDLE_EXTRACTION_FAILED');
    assert(error.kindleExtraction.candidates.some(candidate => /partition.*text/i.test(candidate.error || '')));
    return true;
  });
  await assert.rejects(fs.access(doc.getChapterCachePath(${JSON.stringify(filename)})), {code:'ENOENT'});
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
`;
        execFileSync(process.execPath, ['--require', preload, '-e', invocation], { timeout: 60000, encoding: 'utf8' });
        return { realParserWorker: true, rejectedBeforePublication: true };
      });
    }
    await scenario('Real MOBI clean retry retains the pinned narration after worker rejection', async () => {
      const filename = path.join(temporary, 'kindle-speech-rewrite/source.mobi');
      const chapters = await createBookDocument({log: quiet}).getChaptersCached(filename);
      const expected = require('../test/fixtures/processing-real-corpus.json').cases.find(row => row.id === 'huck-en').expected.normalizedHash;
      assert.equal(digest(normalizedNarrationText(chapters)), expected);
      return { normalizedSourceHash: expected, cleanRetry: true };
    });
    report.passed = report.cases.every(result => result.passed);
  } finally {
    await fs.writeFile(path.join(output, `${process.env.PARTITION_INTEGRITY_PHASE || 'partition-integrity'}.json`), JSON.stringify(report, null, 2));
    await fs.rm(temporary, { recursive: true, force: true });
  }
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
