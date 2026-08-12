/**
 * Deterministic EPUB parsing characterization test.
 *
 * The fixture is generated from synthetic prose on every run. The suite must
 * never depend on private books in cache/ and must never report a green skip.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractChapters } = require('../lib/chapter-extraction');
const { ALLOWED_TEXT_MUTATIONS } = require('../lib/extraction-result');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

const VALID_TYPES = new Set([
  'cover', 'copyright', 'toc', 'frontmatter', 'author',
  'backmatter', 'chapter', 'divider', 'content'
]);

async function createSyntheticEpub() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-characterization-'));
  const root = path.join(directory, 'book');
  const oebps = path.join(root, 'OEBPS');
  await fs.mkdir(path.join(root, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(root, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(root, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const manifest = [1, 2, 3]
    .map(number => `<item id="chapter-${number}" href="chapter-${number}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const spine = [1, 2, 3].map(number => `<itemref idref="chapter-${number}"/>`).join('');
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic Characterization</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest>${manifest}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">${spine}</spine></package>`);
  const nav = [1, 2, 3]
    .map(number => `<navPoint id="chapter-${number}" playOrder="${number}"><navLabel><text>Chapter ${number}</text></navLabel><content src="chapter-${number}.xhtml"/></navPoint>`)
    .join('') + '<navPoint id="duplicate-chapter-2" playOrder="4"><navLabel><text>Chapter 2</text></navLabel><content src="chapter-2.xhtml"/></navPoint>';
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${nav}</navMap></ncx>`);
  for (const number of [1, 2, 3]) {
    const prose = `Synthetic chapter ${number} contains readable narrative prose. `.repeat(80);
    await fs.writeFile(
      path.join(oebps, `chapter-${number}.xhtml`),
      `<html><body><h1>Chapter ${number}</h1><p>${prose}</p></body></html>`
    );
  }
  const epubPath = path.join(directory, 'fixture.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: root });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: root });
  return { directory, epubPath };
}

(async () => {
  const fixture = await createSyntheticEpub();
  try {
    const chapters = await extractChapters(fixture.epubPath);
    assert(Array.isArray(chapters) && chapters.length === 3,
      'returns all three authored chapters');
    assert(chapters.every(chapter =>
      chapter.index !== undefined && chapter.title !== undefined &&
      chapter.text !== undefined && chapter.type !== undefined),
    'all chapters have the required fields');
    assert(chapters.every(chapter => VALID_TYPES.has(chapter.type)),
      'all chapter types are valid');
    assert(chapters.every((chapter, index) => chapter.index === index),
      'chapter indices are sequential');
    assert(chapters.every(chapter => chapter.title && chapter.title.toLowerCase() !== 'none'),
      'chapter titles are not empty placeholders');
    assert(
      JSON.stringify(chapters
        .filter(chapter => /^Chapter \d+$/i.test(chapter.title))
        .map(chapter => Number(chapter.title.match(/\d+/)[0]))) === JSON.stringify([1, 2, 3]),
      'numbered chapter titles remain in authored order'
    );
    assert(chapters.every(chapter => chapter.text.length > 500),
      'every synthetic chapter retains substantial text');
    assert(chapters.every(chapter => !/<\/?[a-z][^>]*>/i.test(chapter.text)),
      'narration contains no raw HTML');
    assert(chapters.some(chapter => chapter.type === 'chapter' || chapter.type === 'content'),
      'the result contains narratable chapter types');
    assert(chapters.every(chapter => Number.isInteger(chapter.originalIndex) && chapter.originalIndex >= 0),
      'all chapters retain valid source indices');
    assert(chapters.mutationActivations.some(mutation =>
      mutation.code === ALLOWED_TEXT_MUTATIONS.EXACT_DUPLICATE_REMOVAL.code && mutation.count === 1),
    'duplicate EPUB TOC targets are removed once and recorded through the closed mutation registry');
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }

  console.log(`EPUB parsing tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
