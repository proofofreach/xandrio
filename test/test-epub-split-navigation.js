// End-to-end regression: synthetic split EPUB -> real document service ->
// HTTP rebuild -> durable cache, listening position and bookmark -> reload.
// Failure cases: physical splits reject a valid TOC; long authored sections
// fragment again; sparse unrelated navigation swallows chapters; text is lost
// or repeated; legacy rebuild overwrites the EPUB; stale memory serves old
// indices; remapping loses a reader; changed narration is silently accepted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createBookDocument } = require('../lib/book-document');
const { chapterStructureKey } = require('../lib/chapter-structure');
const { collapseUnicodeText } = require('../lib/text-normalize');
const { stripHTML } = require('../lib/chapter-utils');
const { createChapterRebuildService } = require('../lib/chapter-rebuild');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-split-navigation-'));
  const cache = path.join(root, 'cache');
  const data = path.join(root, 'data');
  const source = path.join(root, 'source');
  await Promise.all([fs.mkdir(cache), fs.mkdir(data), fs.mkdir(path.join(source, 'META-INF'), { recursive: true })]);
  const titles = ['Introduction', 'Part One: Questions', 'Part Two: Reflections', 'Afterword'];
  const docs = [];
  for (let group = 0; group < titles.length; group++) {
    for (let part = 0; part < 16; part++) {
      const text = part === 0 ? titles[group] : `${part}\n${`Passage ${group + 1}.${part} explores a distinct idea. `.repeat(group === 2 ? 200 : 3)}`;
      docs.push({ id: `g${group}p${part}`, href: `section${group}_split_${String(part).padStart(3, '0')}.xhtml`, group, part, text });
    }
  }
  await fs.writeFile(path.join(source, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(source, 'META-INF/container.xml'), '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  await fs.writeFile(path.join(source, 'content.opf'), `<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Split Navigation</dc:title><dc:language>en</dc:language></metadata><manifest>${docs.map(d => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`).join('')}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">${docs.map(d => `<itemref idref="${d.id}"/>`).join('')}</spine></package>`);
  const ncx = entries => `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${entries.map((d, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${titles[d.group]}</text></navLabel><content src="${d.href}"/></navPoint>`).join('')}</navMap></ncx>`;
  await fs.writeFile(path.join(source, 'toc.ncx'), ncx(docs.filter(d => d.part === 0)));
  for (const d of docs) {
    const [heading, prose = ''] = d.text.split('\n');
    const html = `<html><body><h1>${heading}</h1><p>${prose}</p></body></html>`;
    await fs.writeFile(path.join(source, d.href), html);
    d.text = stripHTML(html).trim();
  }
  const bookPath = path.join(cache, 'splitbook.epub');
  execFileSync('zip', ['-qX0', bookPath, 'mimetype'], { cwd: source });
  execFileSync('zip', ['-qr9', bookPath, 'META-INF', 'content.opf', 'toc.ncx', ...docs.map(d => d.href)], { cwd: source });
  const sourceHash = crypto.createHash('sha256').update(await fs.readFile(bookPath)).digest('hex');
  const previous = docs.map((d, index) => ({ index, title: `Fragment ${index}`, text: d.text, type: 'content', originalIndex: index, estimatedDuration: Math.round(d.text.length / 825 * 60) }));
  const normalizedText = chapters => collapseUnicodeText(chapters.map(c => c.text).join(' '));
  const document = createBookDocument();
  const extracted = await document.extractChapters(bookPath);
  assert.deepEqual(extracted.map(c => c.title), titles, 'physical fragments must resolve to authored TOC sections, including the section over 80k characters');
  assert.equal(normalizedText(extracted), normalizedText(previous), 'every source passage appears exactly once in reading order');
  assert.ok(extracted[2].text.length > 80000, 'exercise the former merge cap');

  // Missing TOC entries must not be concealed just because filenames contain
  // split suffixes. Only referenced logical documents count as covered.
  await fs.writeFile(path.join(source, 'toc.ncx'), ncx(docs.slice(0, 3).map(d => ({ ...d, group: 1 }))));
  const sparsePath = path.join(root, 'sparse.epub');
  execFileSync('zip', ['-qr9', sparsePath, '.'], { cwd: source });
  const sparse = await document.extractChapters(sparsePath);
  assert.ok(sparse.length > titles.length, 'three entries into one logical document do not claim the rest of the book');

  const cachePath = document.getChapterCachePath(bookPath);
  await fs.writeFile(cachePath, JSON.stringify({ _cacheVersion: 31, chapters: previous }));
  const oldKey = chapterStructureKey(previous);
  await fs.writeFile(path.join(data, 'books.json'), JSON.stringify({ splitbook: { id: 'splitbook', title: 'Split Navigation', path: bookPath, chapterCount: previous.length, chapterStructureKey: oldKey, chapterDurations: previous.map(() => 7), chapter1Ready: true, preloadedThrough: 63, audioGenerationTotal: 64 } }));
  await fs.writeFile(path.join(data, 'positions.json'), JSON.stringify({ users: { reader: { splitbook: { chapterIndex: 18, timestamp: 2, characterOffset: 12, chapterStructureKey: oldKey } } } }));
  await fs.writeFile(path.join(data, 'bookmarks.json'), JSON.stringify({ users: { reader: { splitbook: [{ id: 'saved', chapterIndex: 18, timestamp: 2, characterOffset: 12, chapterStructureKey: oldKey }] } } }));
  Object.assign(process.env, { DATA_DIR: data, CACHE_DIR: cache, XANDRIO_TOKEN: 'split-test-token', CHATTERBOX_AUTO_START: 'false', KOKORO_AUTO_START: 'false' });
  const { app } = require('../server');
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer split-test-token' };
  const request = async (route, method = 'GET') => {
    const response = await fetch(`${origin}${route}`, { method, headers });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  try {
    await request('/api/book/splitbook'); // Populate the server's cache first.
    const rebuilt = await request('/api/book/splitbook/rebuild-chapters', 'POST');
    assert.equal(rebuilt.changed, true);
    assert.deepEqual(rebuilt.chapters.map(c => c.title), titles);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(bookPath)).digest('hex'), sourceHash, 'source EPUB is never overwritten');
    const read = async name => JSON.parse(await fs.readFile(path.join(data, name)));
    const persistedBook = (await read('books.json')).splitbook;
    assert.equal(persistedBook.chapterDurations, undefined, 'old chapter durations cannot label the rebuilt chapters');
    assert.equal(persistedBook.audioGenerationTotal, undefined);
    assert.equal(persistedBook.preloadedThrough, null);
    const position = (await read('positions.json')).users.reader.splitbook;
    const bookmark = (await read('bookmarks.json')).users.reader.splitbook[0];
    assert.equal(position.chapterIndex, 1);
    assert.equal(bookmark.chapterIndex, 1);
    assert.equal(position.chapterStructureKey, chapterStructureKey(extracted));
    assert.equal(normalizedText(await createBookDocument().getChaptersCached(bookPath)), normalizedText(previous));
    assert.equal((await request('/api/book/splitbook/rebuild-chapters', 'POST')).changed, false, 'repeating a rebuild is idempotent');
    const damaged = JSON.parse(await fs.readFile(cachePath));
    damaged.chapters[0].text += ' A changed narration must block rebuilding.';
    await fs.writeFile(cachePath, JSON.stringify(damaged));
    const refused = await fetch(`${origin}/api/book/splitbook/rebuild-chapters`, { method: 'POST', headers });
    assert.equal(refused.status, 409, 'changed text must be refused');
    assert.equal(JSON.parse(await fs.readFile(cachePath)).chapters[0].text, damaged.chapters[0].text);
    // Exercise rollback on the actual legacy cache path, then reload the
    // journal with a fresh service as a restarted process would.
    await fs.writeFile(cachePath, JSON.stringify({ _cacheVersion: 31, chapters: previous }));
    const stores = { books: path.join(data, 'books.json'), positions: path.join(data, 'positions.json'), bookmarks: path.join(data, 'bookmarks.json'), transitions: path.join(data, 'chapter-transitions.json') };
    const serviceOptions = { files: stores, bookDocument: createBookDocument(), xbookStore: { planXBookRebuild() { throw new Error('Legacy EPUB must not use XBook parsing'); } } };
    const interrupted = createChapterRebuildService({ ...serviceOptions, onStep(step) { if (step === 'after:artifact') { const error = new Error('simulated crash'); error.simulateCrash = true; throw error; } } });
    await assert.rejects(interrupted.rebuild('splitbook'), /simulated crash/);
    const recovered = await createChapterRebuildService({ ...serviceOptions, bookDocument: createBookDocument() }).recoverAll();
    assert.equal(recovered.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(cachePath)).chapters, previous);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(bookPath)).digest('hex'), sourceHash);
    const output = path.resolve('artifacts/epub-split-navigation-e2e.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ pass: true, sourceHash, physicalDocuments: docs.length, chapterTitles: titles, normalizedChars: normalizedText(extracted).length, position, bookmark, sourcePreserved: true, idempotent: true, changedTextRefused: true, interruptedRebuildRecovered: true }, null, 2));
    console.log(`Split EPUB E2E passed. Receipt: ${output}`);
    console.log('1 passed, 0 failed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
