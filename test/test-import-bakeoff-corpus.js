const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildHistoricalCases,
  downloadHoldoutCases,
  librarySourceDigests,
  sha256File
} = require('../scripts/lib/import-bakeoff-corpus');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-bakeoff-corpus-'));
  try {
    const dataDir = path.join(root, 'data');
    await fs.mkdir(dataDir);
    const books = {};
    const historicalPaths = [];
    for (let index = 0; index < 4; index += 1) {
      const filePath = path.join(root, `known-${index + 1}.epub`);
      await fs.writeFile(filePath, `real historical source ${index + 1}`);
      books[`book-${index + 1}`] = { id: `book-${index + 1}`, path: filePath };
      historicalPaths.push(filePath);
    }
    await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify(books));
    const manifestPath = path.join(root, 'historical.json');
    await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, paths: historicalPaths }));

    const cases = await buildHistoricalCases({ manifestPath, dataDir });
    assert.deepEqual(cases.map(value => value.id), ['known:1', 'known:2', 'known:3', 'known:4']);
    assert(cases.every(value => value.format === 'epub'));
    assert(cases.every(value => value.expectedImportable === true));

    const artifactPath = path.join(root, 'processed.xbook.json');
    await fs.writeFile(artifactPath, JSON.stringify({
      _xbookVersion: 1,
      sourceFormat: 'MOBI',
      chapters: [{ title: 'Chapter', text: 'Already processed narration' }]
    }));
    books['processed-book'] = { id: 'processed-book', path: artifactPath };
    await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify(books));
    await fs.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      paths: [artifactPath, ...historicalPaths.slice(1)]
    }));
    await assert.rejects(() => buildHistoricalCases({ manifestPath, dataDir }), /original source file/);
    await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, paths: historicalPaths }));

    const retainedPath = path.join(root, 'retained.pdf');
    const artifactOnlyPath = path.join(root, 'retained.xbook.json');
    await fs.writeFile(retainedPath, 'retained original PDF source');
    await fs.writeFile(artifactOnlyPath, JSON.stringify({
      _xbookVersion: 1,
      sourceFormat: 'PDF',
      chapters: [{ title: 'Chapter', text: 'Processed narration' }]
    }));
    books['retained-book'] = {
      id: 'retained-book',
      path: artifactOnlyPath,
      sourcePath: retainedPath,
      retainedSourcePath: retainedPath
    };
    await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify(books));
    const retainedDigests = await librarySourceDigests(dataDir);
    assert.equal(retainedDigests.get(
      crypto.createHash('sha256').update('retained original PDF source').digest('hex')
    ), retainedPath);
    await assert.rejects(
      () => sha256File(path.join(root, 'private-missing.epub'), 'historical source 1'),
      error => /historical source 1/.test(error.message) && !error.message.includes(root)
    );

    const duplicatePaths = [];
    for (let index = 0; index < 4; index += 1) {
      const duplicatePath = path.join(root, `duplicate-${index + 1}.epub`);
      await fs.writeFile(duplicatePath, 'the same imported source bytes');
      books[`duplicate-${index + 1}`] = { id: `duplicate-${index + 1}`, path: duplicatePath };
      duplicatePaths.push(duplicatePath);
    }
    await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify(books));
    await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, paths: duplicatePaths }));
    await assert.rejects(
      () => buildHistoricalCases({ manifestPath, dataDir }),
      /four content-distinct books/
    );
    await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, paths: historicalPaths }));

    const holdoutSources = Array.from({ length: 4 }, (_value, index) => ({
      url: `https://example.invalid/holdout-${index + 1}.epub`,
      filename: `holdout-${index + 1}.epub`,
      format: 'epub',
      minimumNormalizedChars: 10000,
      bytes: Buffer.from(`previously unused public-domain source ${index + 1}`)
    }));
    const holdoutManifestPath = path.join(root, 'holdouts.json');
    await fs.writeFile(holdoutManifestPath, JSON.stringify({
      schemaVersion: 1,
      sources: holdoutSources.map(({ bytes, ...source }) => ({
        ...source,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }))
    }));
    const byUrl = new Map(holdoutSources.map(value => [value.url, value.bytes]));
    const holdouts = await downloadHoldoutCases({
      manifestPath: holdoutManifestPath,
      directory: path.join(root, 'holdouts'),
      libraryDigests: await librarySourceDigests(dataDir),
      fetchImpl: async url => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => byUrl.get(url)
      })
    });
    assert.deepEqual(holdouts.map(value => value.id), ['new:1', 'new:2', 'new:3', 'new:4']);
    assert(holdouts.every(value => value.expectedImportable === true));

    const reusedBytes = Buffer.from('real historical source 1');
    const reusedSources = holdoutSources.map((source, index) => ({
      ...source,
      bytes: index === 0 ? reusedBytes : source.bytes
    }));
    await fs.writeFile(holdoutManifestPath, JSON.stringify({
      schemaVersion: 1,
      sources: reusedSources.map(({ bytes, ...source }) => ({
        ...source,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }))
    }));
    const reusedByUrl = new Map(reusedSources.map(value => [value.url, value.bytes]));
    const currentLibraryDigests = await librarySourceDigests(dataDir);
    await assert.rejects(() => downloadHoldoutCases({
      manifestPath: holdoutManifestPath,
      directory: path.join(root, 'reused-holdouts'),
      libraryDigests: currentLibraryDigests,
      fetchImpl: async url => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => reusedByUrl.get(url)
      })
    }), /already present in the library/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log('18 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
