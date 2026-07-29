const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseEpub } = require('../lib/epub-parser');
const { extractChapters } = require('../lib/chapter-extraction');
const { extractCover } = require('../lib/cover-service');
const { createBookDocument } = require('../lib/book-document');

const SCANNED_CHAPTER_TITLE_LINES = [
  ['Remembering Our Ancient Past'],
  ['The Secret of the Flower Unfolds'],
  ['The Darker Side of Our Present and Past'],
  ['The Aborted Evolution of Consciousness', 'and the Creation of the Christ Grid'],
  ['Egypt’s Role in the Evolution of Consciousness'],
  ['The Significance of Shape and Structure'],
  ['The Measuring Stick of the Universe:', 'The Human Body and Its Geometries'],
  ['Reconciling the Fibonacci-Binary Polarity']
];
const SCANNED_CHAPTER_TITLES = SCANNED_CHAPTER_TITLE_LINES.map(lines => lines.join(' '));

function jpegFixture() {
  const image = Buffer.alloc(1400, 8);
  image[0] = 0xff;
  image[1] = 0xd8;
  image[2] = 0xff;
  image[3] = 0xe0;
  image.writeUInt16BE(16, 4);
  image[20] = 0xff;
  image[21] = 0xc0;
  image.writeUInt16BE(17, 22);
  image[24] = 8;
  image.writeUInt16BE(400, 25);
  image.writeUInt16BE(320, 27);
  image[29] = 3;
  image[image.length - 2] = 0xff;
  image[image.length - 1] = 0xd9;
  return image;
}

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-parser-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Adapter Book</dc:title><dc:creator>Adapter Author</dc:creator><dc:language>en</dc:language><meta name="cover" content="cover-image"/></metadata><manifest><item id="chapter-1" href="chapter%20one.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover-image" href="cover.jpg" media-type="image/jpeg"/></manifest><spine toc="ncx"><itemref idref="chapter-1"/></spine></package>`);
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="chapter-1" playOrder="1"><navLabel><text>1</text></navLabel><content src="chapter%20one.xhtml"/></navPoint></navMap></ncx>`);
  await fs.writeFile(path.join(oebps, 'chapter one.xhtml'), `<html><head><style>.hidden{display:none}</style></head><body><h1>Opening</h1><script>bad()</script><p>${'Readable prose. '.repeat(800)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'cover.jpg'), jpegFixture());

  const epubPath = path.join(directory, 'fixture.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: epubRoot });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: epubRoot });
  return { directory, epubPath };
}

async function createOversizedAuthoredChapterFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-oversized-chapter-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Long Authored Chapters</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/><item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/><item id="chapter-3" href="chapter-3.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="chapter-1"/><itemref idref="chapter-2"/><itemref idref="chapter-3"/></spine></package>`);
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="nav-1" playOrder="1"><navLabel><text>Chapter 1: In Their Own Words</text></navLabel><content src="chapter-1.xhtml"/></navPoint><navPoint id="nav-2" playOrder="2"><navLabel><text>Chapter 2: The Next Chapter</text></navLabel><content src="chapter-2.xhtml"/></navPoint><navPoint id="nav-3" playOrder="3"><navLabel><text>Chapter 3: The Last Chapter</text></navLabel><content src="chapter-3.xhtml"/></navPoint></navMap></ncx>`);
  const longProse = 'The authored chapter continues with readable prose and supporting analysis. '.repeat(1500);
  await fs.writeFile(path.join(oebps, 'chapter-1.xhtml'), `<html><body><h1>Chapter 1: In Their Own Words</h1><p>${longProse}</p><h2>7601. Canvass of districts for taxable persons and objects</h2><p>${'Quoted statutory material remains part of the authored chapter. '.repeat(80)}</p><h2>INTERNAL REVENUE DISTRICTS</h2><p>${'This subsection also remains inside the authored chapter. '.repeat(80)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'chapter-2.xhtml'), `<html><body><h1>Chapter 2: The Next Chapter</h1><p>${'Second chapter prose. '.repeat(10)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'chapter-3.xhtml'), `<html><body><h1>Chapter 3: The Last Chapter</h1><p>${'Third chapter prose. '.repeat(10)}</p></body></html>`);

  const epubPath = path.join(directory, 'fixture.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: epubRoot });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: epubRoot });
  return { directory, epubPath };
}

async function createNonLinearFootnoteFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-nonlinear-footnotes-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Non-linear Footnotes</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="introduction" href="introduction.xhtml" media-type="application/xhtml+xml"/><item id="chapter-bundle" href="chapter-bundle.xhtml" media-type="application/xhtml+xml"/><item id="photographs" href="photographs.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/><item id="bibliography" href="bibliography.xhtml" media-type="application/xhtml+xml"/><item id="index" href="index.xhtml" media-type="application/xhtml+xml"/><item id="chapter-fn1" href="chapter_fn1.xhtml" media-type="application/xhtml+xml"/><item id="chapter-fn2" href="chapter_fn2.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="introduction"/><itemref idref="chapter-bundle"/><itemref idref="chapter-fn1" linear="no"/><itemref idref="chapter-fn2" linear="no"/><itemref idref="photographs"/><itemref idref="notes"/><itemref idref="bibliography"/><itemref idref="index"/></spine></package>`);
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="nav-introduction" playOrder="1"><navLabel><text>Introduction</text></navLabel><content src="introduction.xhtml"/></navPoint><navPoint id="nav-chapter-1" playOrder="2"><navLabel><text>1. Opening</text></navLabel><content src="chapter-bundle.xhtml#opening"/></navPoint><navPoint id="nav-chapter-2" playOrder="3"><navLabel><text>2. Continuation</text></navLabel><content src="chapter-bundle.xhtml#continuation"/></navPoint><navPoint id="nav-chapter-3" playOrder="4"><navLabel><text>3. Conclusion</text></navLabel><content src="chapter-bundle.xhtml#conclusion"/></navPoint><navPoint id="nav-photographs" playOrder="5"><navLabel><text>Photographs</text></navLabel><content src="photographs.xhtml"/></navPoint><navPoint id="nav-notes" playOrder="6"><navLabel><text>Notes</text></navLabel><content src="notes.xhtml"/></navPoint><navPoint id="nav-bibliography" playOrder="7"><navLabel><text>Bibliography</text></navLabel><content src="bibliography.xhtml"/></navPoint><navPoint id="nav-index" playOrder="8"><navLabel><text>Index</text></navLabel><content src="index.xhtml"/></navPoint></navMap></ncx>`);
  await fs.writeFile(path.join(oebps, 'introduction.xhtml'), `<html><body><h1>Introduction</h1><p>${'Introductory prose. '.repeat(80)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'chapter-bundle.xhtml'), `<html><body><section id="opening"><h1>1. Opening</h1><p>${'Opening chapter prose. '.repeat(120)}</p></section><section id="continuation"><h1>2. Continuation</h1><p>${'Continuation chapter prose. '.repeat(120)}</p></section><section id="conclusion"><h1>3. Conclusion</h1><p>${'Conclusion chapter prose. '.repeat(120)}</p></section></body></html>`);
  await fs.writeFile(path.join(oebps, 'photographs.xhtml'), `<html><body><p>1. First authored plate caption</p><p>2. Second authored plate caption</p><p>3. Third authored plate caption</p><p>${'Additional plate description. '.repeat(40)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'notes.xhtml'), `<html><body><h1>Notes</h1><p>${'Authored source note. '.repeat(120)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'bibliography.xhtml'), `<html><body><h1>Bibliography</h1><p>${'Bibliographic entry. '.repeat(80)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'index.xhtml'), `<html><body><h1>Index</h1><p>${'Index entry. '.repeat(100)}</p></body></html>`);
  const detachedFootnote = 'Detached popup footnote must not become sequential audiobook content. '.repeat(700);
  await fs.writeFile(path.join(oebps, 'chapter_fn1.xhtml'), `<html><body><aside>${detachedFootnote}</aside></body></html>`);
  await fs.writeFile(path.join(oebps, 'chapter_fn2.xhtml'), `<html><body><aside>${detachedFootnote}</aside></body></html>`);

  const epubPath = path.join(directory, 'fixture.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: epubRoot });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: epubRoot });
  return { directory, epubPath };
}

async function createScannedChapterBundleFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-scanned-bundle-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

  const tocNumbers = ['I', '2', '3', '4', '6', '7', '8'];
  const pages = [7, 34, 68, 94, 126, 155, 184, 208];
  const stubManifest = tocNumbers
    .map(number => `<item id="stub-${number}" href="chapter-${number}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const imageManifest = pages
    .map(pageNumber => `<item id="page-${pageNumber}" href="index-${pageNumber}.jpg" media-type="image/jpeg"/>`)
    .join('');
  const stubSpine = tocNumbers.map(number => `<itemref idref="stub-${number}"/>`).join('');
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Malformed Scanned Book</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="introduction" href="introduction.xhtml" media-type="application/xhtml+xml"/>${stubManifest}${imageManifest}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="introduction"/>${stubSpine}</spine></package>`);

  const navPoints = tocNumbers
    .map((number, index) => `<navPoint id="nav-${number}" playOrder="${index + 1}"><navLabel><text>Chapter ${number}</text></navLabel><content src="chapter-${number}.xhtml"/></navPoint>`)
    .join('');
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${navPoints}</navMap></ncx>`);

  const printedNumbers = ['ONE', 'TWO', 'THREE', 'FOUR', 'F I V E', 'S I X', 'SEVEN', 'EIGHT'];
  const chapterBody = 'Scanned chapter prose remains readable and belongs to its authored chapter. '.repeat(320);
  const scannedChapters = pages.map((pageNumber, index) => {
    const openerImage = index === 3 ? '' : `<img src="index-${pageNumber}.jpg" />`;
    const malformedLead = index === 3
      ? `<p>${'OCR words displaced ahead of the title. '.repeat(12)}</p>`
      : '';
    const titleMarkup = SCANNED_CHAPTER_TITLE_LINES[index]
      .map(line => `<p><b>${line}</b></p>`)
      .join('');
    return `${openerImage}${malformedLead}<p>${printedNumbers[index]}</p>${titleMarkup}<p><b>First authored subsection</b></p><p>${chapterBody}</p>`;
  }).join('');
  const afterword = `<p>AFTERWORD</p><p>${'Closing reflections belong to the authored afterword. '.repeat(20)}</p><p>REFERENCES</p><p>${'A cited source belongs to the reference section. '.repeat(20)}</p><p>INDEX</p><p>Short trailing index entry must not be discarded.</p>`;
  await fs.writeFile(
    path.join(oebps, 'introduction.xhtml'),
    `<html><body><h1>Introduction</h1><p>${'Introductory context. '.repeat(80)}</p>${scannedChapters}${afterword}</body></html>`
  );
  for (const pageNumber of pages) {
    await fs.writeFile(path.join(oebps, `index-${pageNumber}.jpg`), jpegFixture());
  }

  const stubText = 'Scanned chapter prose remains readable and belongs to its authored chapter. '.repeat(5);
  for (const number of tocNumbers) {
    await fs.writeFile(
      path.join(oebps, `chapter-${number}.xhtml`),
      `<html><body><h1>Chapter ${number}</h1><p>${stubText}</p></body></html>`
    );
  }

  const epubPath = path.join(directory, 'fixture.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: epubRoot });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: epubRoot });
  return { directory, epubPath };
}

(async () => {
  const { directory, epubPath } = await createFixture();
  try {
    const epub = await parseEpub(epubPath);
    assert.equal(epub.metadata.title, 'Adapter Book');
    assert.equal(epub.metadata.creator, 'Adapter Author');
    assert.equal(epub.flow.length, 1);
    assert.equal(epub.toc[0].title, '1');
    assert.match(await epub.getChapter('chapter-1'), /^<h1>Opening<\/h1><p>Readable prose/);

    const cover = await epub.getImage(epub.metadata.cover);
    assert.deepEqual(cover, jpegFixture());

    const chapters = await extractChapters(epubPath);
    assert.equal(chapters.length, 1);
    assert.match(chapters[0].text, /Readable prose/);

    const document = createBookDocument({ log: { log() {}, error() {} } });
    assert.equal((await document.extractMetadata(epubPath)).title, 'Adapter Book');

    const coverPath = path.join(directory, 'cover.jpg');
    assert.equal(await extractCover(epubPath, coverPath), true);
    assert.deepEqual(await fs.readFile(coverPath), jpegFixture());
    console.log('Epub parser tests: 11 passed, 0 failed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  const oversizedFixture = await createOversizedAuthoredChapterFixture();
  try {
    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(oversizedFixture.epubPath);
    assert.deepEqual(
      chapters.map(chapter => chapter.title),
      [
        'Chapter 1: In Their Own Words',
        'Chapter 2: The Next Chapter',
        'Chapter 3: The Last Chapter'
      ],
      'an oversized authored chapter keeps its TOC boundary instead of promoting subsections'
    );
    assert.match(chapters[0].text, /7601\. Canvass of districts/);
    assert.match(chapters[0].text, /INTERNAL REVENUE DISTRICTS/);
    console.log('Oversized authored chapter regression: 3 passed, 0 failed');
  } finally {
    await fs.rm(oversizedFixture.directory, { recursive: true, force: true });
  }

  const nonLinearFixture = await createNonLinearFootnoteFixture();
  try {
    const epub = await parseEpub(nonLinearFixture.epubPath);
    assert.equal(epub.spineLinearityVerified, true, 'the EPUB adapter verifies OPF reading order');
    assert.equal(epub.flow[2].linear, false, 'the EPUB adapter preserves OPF linear="no"');

    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(nonLinearFixture.epubPath);
    assert.deepEqual(
      chapters.map(chapter => chapter.title),
      ['Introduction', '1. Opening', '2. Continuation', '3. Conclusion', 'Photographs', 'Notes', 'Bibliography', 'Index'],
      'interleaved non-linear popup documents do not leak into anchor-based chapter ranges'
    );
    assert.equal(chapters[4].type, 'content', 'a trusted Photographs title is not rewritten as Contents');
    assert.equal(chapters.find(chapter => chapter.title === 'Notes').type, 'backmatter');
    assert.equal(
      chapters.some(chapter => chapter.text.includes('Detached popup footnote')),
      false,
      'terminal TOC ranges exclude non-linear spine text'
    );
    console.log('Non-linear EPUB spine regression: 6 passed, 0 failed');
  } finally {
    await fs.rm(nonLinearFixture.directory, { recursive: true, force: true });
  }

  const scannedFixture = await createScannedChapterBundleFixture();
  try {
    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(scannedFixture.epubPath);
    assert.deepEqual(
      chapters.map(chapter => chapter.title),
      [
        'Introduction',
        ...SCANNED_CHAPTER_TITLES,
        'Afterword',
        'References'
      ],
      'a malformed scanned chapter bundle recovers printed titles and back matter boundaries'
    );
    assert.equal(
      chapters.some(chapter => / — Part \d+ of \d+$/.test(chapter.title)),
      false,
      'recovered chapters do not fall back to arbitrary oversized parts'
    );
    assert.match(chapters[3].text, /OCR words displaced ahead of the title/);
    assert.doesNotMatch(chapters[4].text, /OCR words displaced ahead of the title/);
    assert.doesNotMatch(chapters[8].text, /AFTERWORD/);
    assert.equal(chapters[9].type, 'backmatter');
    assert.equal(chapters[10].type, 'backmatter');
    assert.match(chapters[10].text, /Short trailing index entry must not be discarded/);
    console.log('Scanned chapter bundle regression: 8 passed, 0 failed');
  } finally {
    await fs.rm(scannedFixture.directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  console.log('Epub parser tests: 0 passed, 1 failed');
  process.exitCode = 1;
});
