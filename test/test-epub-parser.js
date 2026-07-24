const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseEpub } = require('../lib/epub-parser');
const { extractChapters } = require('../lib/chapter-extraction');
const { extractCover } = require('../lib/cover-service');
const { createBookDocument } = require('../lib/book-document');

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
})().catch(error => {
  console.error(error);
  console.log('Epub parser tests: 0 passed, 1 failed');
  process.exitCode = 1;
});
