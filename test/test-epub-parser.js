const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseEpub } = require('../lib/epub-parser');
const { extractChapters } = require('../lib/chapter-extraction');
const { extractCover } = require('../lib/cover-service');
const { createBookDocument } = require('../lib/book-document');
const { UNUSABLE_CHAPTER_THRESHOLD } = require('../lib/chapter-utils');

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

async function createEmptyAnchorTocFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-empty-anchor-toc-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Empty Anchor TOC</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="book"/></spine></package>`);
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="nav-publisher" playOrder="1"><navLabel><text>Publisher Navigation</text></navLabel><content src="book.xhtml#publisher"/></navPoint><navPoint id="nav-foreword" playOrder="2"><navLabel><text>FOREWORD</text></navLabel><content src="book.xhtml#foreword"/></navPoint><navPoint id="nav-thought" playOrder="3"><navLabel><text>THOUGHT AND CHARACTER</text></navLabel><content src="book.xhtml#thought"/></navPoint><navPoint id="nav-serenity" playOrder="4"><navLabel><text>SERENITY</text></navLabel><content src="book.xhtml#serenity"/></navPoint></navMap></ncx>`);
  await fs.writeFile(
    path.join(oebps, 'book.xhtml'),
    `<html><body><div id="publisher"></div><h2 id="foreword">FOREWORD</h2><p>${'The foreword explains the purpose of this short work. '.repeat(30)}</p><h2 id="thought">THOUGHT AND CHARACTER</h2><p>${'The opening essay discusses thought and character. '.repeat(40)}</p><h2 id="serenity">SERENITY</h2><p>${'The closing essay discusses serenity and self-control. '.repeat(40)}</p></body></html>`
  );

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

async function createHeadingBackedSpineFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-heading-spine-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

  const spineIds = [
    'acclaim', 'other-books', 'acclaim-continued', 'contents', 'dedication',
    'introduction', 'part-1',
    ...Array.from({ length: 8 }, (_unused, index) => `chapter-${index + 1}`),
    'debts', 'sources', 'bibliography', 'notes', 'credits', 'about-author', 'copyright'
  ];
  const manifest = spineIds
    .map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const spine = spineIds.map(id => `<itemref idref="${id}"/>`).join('');
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Heading Spine Book</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest>${manifest}</manifest><spine>${spine}</spine><guide><reference type="toc" title="Table of Contents" href="contents.xhtml"/><reference type="copyright-page" title="Copyright" href="copyright.xhtml"/></guide></package>`);

  await fs.writeFile(path.join(oebps, 'acclaim.xhtml'), `<html><body class="chapter"><h1>Acclaim for THE EXAMPLE BOOK</h1><p>${'Published review praise. '.repeat(220)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'other-books.xhtml'), `<html><body class="otherbooks"><h1>Also by Fixture Author</h1><p>Earlier Work</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'acclaim-continued.xhtml'), `<html><body class="chapter">${Array.from({ length: 8 }, (_unused, index) => `<blockquote>Review quotation ${index + 1}.</blockquote><p class="attribution">Reviewer ${index + 1}</p>`).join('')}</body></html>`);
  await fs.writeFile(path.join(oebps, 'contents.xhtml'), `<html><body><h1>Contents</h1><p>${'1 The First Chapter 2 The Second Chapter '.repeat(20)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'dedication.xhtml'), '<html><body class="dedication"><p>For the reader.</p></body></html>');
  await fs.writeFile(path.join(oebps, 'introduction.xhtml'), `<html><body class="preface"><h1>INTRODUCTION Patterns</h1><p>${'Introductory narrative. '.repeat(1600)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'part-1.xhtml'), '<html><body><h1>Part I<br/>THE BEGINNING</h1></body></html>');

  for (let number = 1; number <= 8; number += 1) {
    const title = number === 6
      ? '“The Quoted Sixth”'
      : number === 8
        ? '“Quoted” Eighth'
        : `The ${['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][number - 1]} Chapter`;
    const repeat = [1, 7].includes(number) ? 5200 : 900;
    const opening = number === 1
      ? '<p>The subject was born in an example town.</p>'
      : '<p>The chapter opens with narrative prose.</p>';
    await fs.writeFile(
      path.join(oebps, `chapter-${number}.xhtml`),
      `<html><body><h1><span>${number}</span><br/><span>${title}</span></h1>${opening}<p>${'Authored chapter prose continues. '.repeat(repeat)}</p></body></html>`
    );
  }

  await fs.writeFile(path.join(oebps, 'debts.xhtml'), `<html><body><h1>Debts</h1><p>${'Closing narrative. '.repeat(400)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'sources.xhtml'), `<html><body><h1>A Note on Sources</h1><p>${'Source discussion. '.repeat(800)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'bibliography.xhtml'), `<html><body><h1>Selected Bibliography</h1><p>${'Bibliographic entry. '.repeat(800)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'notes.xhtml'), `<html><body><h1>Notes</h1><p>${'Endnote entry. '.repeat(9000)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'credits.xhtml'), `<html><body class="appendix"><h1>PHOTOGRAPHIC CREDITS</h1><p>${'Image credit. '.repeat(120)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'about-author.xhtml'), `<html><body class="preface"><p>Ada Q. Writer is the author of several biographies and was born in an example city.</p><p>${'Biographical detail. '.repeat(120)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'copyright.xhtml'), '<html><body class="copyright"><p>Copyright © 2026 Fixture Author. All rights reserved. ISBN 0000000000.</p></body></html>');

  const epubPath = path.join(directory, 'fixture.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: epubRoot });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: epubRoot });
  return { directory, epubPath };
}

async function createSingleSpineOversizedFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-single-spine-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Single Spine Book</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="book"/></spine></package>`);
  await fs.writeFile(path.join(oebps, 'book.xhtml'), `<html><body><h1>Single Spine Book</h1><p>${'Unstructured book prose continues. '.repeat(5200)}</p></body></html>`);
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

async function createFrontMatterPartContextFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-frontmatter-parts-'));
  const epubRoot = path.join(directory, 'book');
  const oebps = path.join(epubRoot, 'OEBPS');
  await fs.mkdir(path.join(epubRoot, 'META-INF'), { recursive: true });
  await fs.mkdir(oebps, { recursive: true });
  await fs.writeFile(path.join(epubRoot, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(epubRoot, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  await fs.writeFile(path.join(oebps, 'content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Four-Part Fixture</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="htmltoc" href="htmltoc.xhtml" media-type="application/xhtml+xml"/><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/><item id="part-one" href="part-one.xhtml" media-type="application/xhtml+xml"/><item id="one-a" href="one-a.xhtml" media-type="application/xhtml+xml"/><item id="part-two" href="part-two.xhtml" media-type="application/xhtml+xml"/><item id="one-b" href="one-b.xhtml" media-type="application/xhtml+xml"/><item id="twenty-five" href="twenty-five.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="htmltoc"/><itemref idref="title"/><itemref idref="part-one"/><itemref idref="one-a"/><itemref idref="part-two"/><itemref idref="one-b"/><itemref idref="twenty-five"/></spine></package>`);
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="title" playOrder="1"><navLabel><text>Four-Part Fixture</text></navLabel><content src="title.xhtml"/></navPoint><navPoint id="part-one" playOrder="2"><navLabel><text>Part I: The Beginning</text></navLabel><content src="part-one.xhtml"/><navPoint id="one-a" playOrder="3"><navLabel><text>Chapter I</text></navLabel><content src="one-a.xhtml"/></navPoint></navPoint><navPoint id="part-two" playOrder="4"><navLabel><text>Part II: The Continuation</text></navLabel><content src="part-two.xhtml"/><navPoint id="one-b" playOrder="5"><navLabel><text>Chapter I</text></navLabel><content src="one-b.xhtml"/></navPoint><navPoint id="twenty-five" playOrder="6"><navLabel><text>Chapter XXV</text></navLabel><content src="twenty-five.xhtml"/></navPoint></navPoint></navMap></ncx>`);
  await fs.writeFile(path.join(oebps, 'htmltoc.xhtml'), `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><h1>Four-Part Fixture</h1><h2>Table of Contents</h2><nav epub:type="toc"><ol><li><a href="title.xhtml">Four-Part Fixture</a></li><li><a href="part-one.xhtml">Part I: The Beginning</a><ol><li><a href="one-a.xhtml">Chapter I</a></li></ol></li><li><a href="part-two.xhtml">Part II: The Continuation</a><ol><li><a href="one-b.xhtml">Chapter I</a></li><li><a href="twenty-five.xhtml">Chapter XXV</a></li></ol></li></ol></nav><p>${'Chapter I Chapter XXV Part I Part II. '.repeat(35)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'title.xhtml'), `<html><body><h1>Four-Part Fixture</h1><p>Copyright © 2026 Fixture Author. All rights reserved.</p><p>${'Publication and edition notice. '.repeat(24)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'part-one.xhtml'), '<html><body><h1>Part I: The Beginning</h1></body></html>');
  await fs.writeFile(path.join(oebps, 'one-a.xhtml'), `<html><body><h1>Chapter I</h1><p>${'The first part begins with authored narrative. '.repeat(80)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'part-two.xhtml'), '<html><body><h1>Part II: The Continuation</h1></body></html>');
  await fs.writeFile(path.join(oebps, 'one-b.xhtml'), `<html><body><h1>Chapter I</h1><p>${'The second part repeats the chapter number. '.repeat(80)}</p></body></html>`);
  await fs.writeFile(path.join(oebps, 'twenty-five.xhtml'), `<html><body><h1>Chapter XXV</h1><p>${'The later unique chapter remains inside the second part. '.repeat(80)}</p></body></html>`);

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

  const headingSpineFixture = await createHeadingBackedSpineFixture();
  try {
    const epub = await parseEpub(headingSpineFixture.epubPath);
    assert.equal(epub.toc.length, 0, 'fixture exercises the no-NCX spine fallback');
    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(headingSpineFixture.epubPath);
    const numbered = chapters.filter(chapter => /^(?:[1-8])\s/.test(chapter.title));
    assert.deepEqual(
      [...new Set(numbered.map(chapter => chapter.sourceTitle || chapter.title))],
      [
        '1 The First Chapter',
        '2 The Second Chapter',
        '3 The Third Chapter',
        '4 The Fourth Chapter',
        '5 The Fifth Chapter',
        '6 “The Quoted Sixth”',
        '7 The Seventh Chapter',
        '8 “Quoted” Eighth'
      ],
      'heading-backed spine chapters keep their authored titles'
    );
    assert(numbered.every(chapter => chapter.type === 'chapter'));
    // The authored boundary is honoured up to the size at which a single
    // section becomes unplayable; chapters 1 and 7 are built past that line and
    // must be repaired rather than left to fail import.
    assert.deepEqual(
      [...new Set(
        chapters
          .filter(chapter => chapter.splitFromOversizedChapter)
          .map(chapter => chapter.sourceTitle)
      )],
      ['1 The First Chapter', '7 The Seventh Chapter'],
      'only sections past the unusable threshold are split'
    );
    assert(
      chapters.every(chapter => (chapter.text || '').length <= UNUSABLE_CHAPTER_THRESHOLD),
      'no extracted section is left above the size that rejects the import'
    );
    assert.equal(chapters.find(chapter => chapter.title === 'INTRODUCTION Patterns').type, 'frontmatter');
    assert.equal(chapters.find(chapter => chapter.title === 'Acclaim for THE EXAMPLE BOOK').type, 'frontmatter');
    assert.equal(chapters.find(chapter => chapter.title === 'Notes').type, 'backmatter');
    assert.equal(chapters.find(chapter => chapter.title === 'Photographic Credits').type, 'backmatter');
    assert.equal(chapters.find(chapter => chapter.type === 'author').title, 'About the Author');
    console.log('Heading-backed spine regression: 9 passed, 0 failed');
  } finally {
    await fs.rm(headingSpineFixture.directory, { recursive: true, force: true });
  }

  const singleSpineFixture = await createSingleSpineOversizedFixture();
  try {
    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(singleSpineFixture.epubPath);
    assert(chapters.length > 1, 'one book-title heading does not suppress unstructured fallback splitting');
    assert(chapters.every(chapter => chapter.splitFromOversizedChapter));
    console.log('Single-spine oversized fallback regression: 2 passed, 0 failed');
  } finally {
    await fs.rm(singleSpineFixture.directory, { recursive: true, force: true });
  }

  const emptyAnchorFixture = await createEmptyAnchorTocFixture();
  try {
    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(emptyAnchorFixture.epubPath);
    assert.deepEqual(
      chapters.map(chapter => chapter.title),
      ['Foreword', 'Thought And Character', 'Serenity'],
      'empty same-file TOC anchors do not shift authored titles onto following sections'
    );
    assert.equal(chapters[0].type, 'frontmatter');
    assert.match(chapters[0].text, /foreword explains the purpose/);
    assert.match(chapters[1].text, /opening essay discusses thought/);
    console.log('Empty-anchor TOC regression: 4 passed, 0 failed');
  } finally {
    await fs.rm(emptyAnchorFixture.directory, { recursive: true, force: true });
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

  const frontMatterPartFixture = await createFrontMatterPartContextFixture();
  try {
    const document = createBookDocument({ log: { log() {}, error() {} } });
    const chapters = await document.extractChapters(frontMatterPartFixture.epubPath);
    assert.equal(chapters[0].type, 'toc', 'an HTML table of contents is non-narrative front matter');
    assert.equal(chapters[1].type, 'copyright', 'a title/copyright leaf is non-narrative front matter');
    assert.equal(
      chapters.find(chapter => chapter.text.startsWith('Chapter XXV'))?.title,
      'Part II: The Continuation — Chapter XXV',
      'part context remains on unique Roman-numeral chapters after duplicate chapter numbers'
    );
    console.log('Front-matter and part-context regression: 3 passed, 0 failed');
  } finally {
    await fs.rm(frontMatterPartFixture.directory, { recursive: true, force: true });
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
