// Failure modes: TOC return links hide prose chapters; genuine contents pages
// lose their type; repairing a stored cache changes narration or indices.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSyntheticImportEpub } = require('./lib/import-benchmark-fixtures');
const { createBookDocument } = require('../lib/book-document');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contents-backlinks-'));
  const evidence = { passed: false, cases: [] };
  try {
    const source = await createSyntheticImportEpub(root);
    const oebps = path.join(root, 'epub-source/OEBPS');
    for (const number of [1, 2, 3]) {
      const file = path.join(oebps, `chapter-${number}.xhtml`);
      const html = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, html.replace('</h1>', '</h1><div><a href="contents.xhtml">Table of Contents</a></div>'));
    }
    execFileSync('zip', ['-qr9', source, 'OEBPS'], { cwd: path.join(root, 'epub-source') });
    const document = createBookDocument();
    const chapters = await document.extractChapters(source);
    assert.deepEqual(chapters.map(c => c.title), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
    assert(chapters.every(c => !['toc', 'frontmatter'].includes(c.type)));
    evidence.cases.push('EPUB import retains chapters with contents return links');
    const legacy = chapters.map(c => ({ ...c, title: 'Contents', type: 'toc', rawTitle: c.title, rawType: c.type }));
    await fs.writeFile(document.getChapterCachePath(source), JSON.stringify({ _cacheVersion: 31, chapters: legacy }));
    const cached = await createBookDocument().getChaptersCached(source);
    assert.deepEqual(cached.map(c => c.title), chapters.map(c => c.title));
    assert.deepEqual(cached.map(c => c.type), chapters.map(c => c.type));
    assert.deepEqual(cached.map(c => [c.index, c.text, c.estimatedDuration]), legacy.map(c => [c.index, c.text, c.estimatedDuration]));
    const persisted = JSON.parse(await fs.readFile(document.getChapterCachePath(source), 'utf8'));
    assert.deepEqual(persisted.chapters, cached);
    evidence.cases.push('existing cache repaired without changing text, indices, or duration');
    const genuine = { index: 0, title: 'Contents', type: 'toc', text: 'Table of Contents\nChapter 1\nChapter 2', estimatedDuration: 1 };
    await fs.writeFile(document.getChapterCachePath(source), JSON.stringify({ _cacheVersion: 31, chapters: [genuine] }));
    assert.deepEqual(await createBookDocument().getChaptersCached(source), [genuine]);
    evidence.cases.push('genuine contents retained');
    evidence.passed = true;
    console.log('PASS contents backlink import and stored-cache repair');
    console.log(`${evidence.cases.length} passed, 0 failed`);
  } finally {
    await fs.mkdir('output/playback-processing', { recursive: true });
    await fs.writeFile('output/playback-processing/contents-backlinks.json', JSON.stringify(evidence, null, 2));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
