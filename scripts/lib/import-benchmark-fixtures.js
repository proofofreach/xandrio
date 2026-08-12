const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function prose(label, repetitions = 180) {
  return `${label} is synthetic prose with complete sentences and stable audiobook content. `.repeat(repetitions);
}

async function createSyntheticImportEpub(directory) {
  const root = path.join(directory, 'epub-source');
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
<package version="2.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic Import Benchmark</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language></metadata><manifest>${manifest}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">${spine}</spine></package>`);
  const navigation = [1, 2, 3]
    .map(number => `<navPoint id="chapter-${number}" playOrder="${number}"><navLabel><text>Chapter ${number}</text></navLabel><content src="chapter-${number}.xhtml"/></navPoint>`)
    .join('');
  await fs.writeFile(path.join(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${navigation}</navMap></ncx>`);
  for (const number of [1, 2, 3]) {
    await fs.writeFile(
      path.join(oebps, `chapter-${number}.xhtml`),
      `<html><body><h1>Chapter ${number}</h1><p>${prose(`EPUB chapter ${number}`, 80)}</p></body></html>`
    );
  }
  const epubPath = path.join(directory, 'synthetic-import.epub');
  execFileSync('zip', ['-qX0', epubPath, 'mimetype'], { cwd: root });
  execFileSync('zip', ['-qr9', epubPath, 'META-INF', 'OEBPS'], { cwd: root });
  return epubPath;
}

function pdfSourceDocument() {
  return {
    _pdfStructureVersion: 2,
    pageCount: 3,
    pages: [1, 2, 3].map(pageNumber => ({
      pageNumber,
      text: `CHAPTER ${pageNumber}\n\n${prose(`PDF page ${pageNumber}`)}`
    }))
  };
}

function kindleParserConfig() {
  return {
    spine: [{ id: 'c1' }, { id: 'c2' }],
    toc: [
      { label: 'Chapter One', href: 'text/c1.html' },
      { label: 'Chapter Two', href: 'text/c2.html' }
    ],
    resolve: {
      'text/c1.html': { id: 'c1', selector: '' },
      'text/c2.html': { id: 'c2', selector: '' }
    },
    chapters: {
      c1: `<html><body><h1>Chapter One</h1><p>${prose('Kindle chapter one')}</p></body></html>`,
      c2: `<html><body><h1>Chapter Two</h1><p>${prose('Kindle chapter two')}</p></body></html>`
    }
  };
}

module.exports = {
  createSyntheticImportEpub,
  kindleParserConfig,
  pdfSourceDocument,
  prose
};
