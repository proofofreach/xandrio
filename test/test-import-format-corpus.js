const assert = require('assert');
const { reprocessPdfSourceDocument } = require('../lib/pdf-extraction');
const { extractKindleChapters } = require('../lib/kindle-extraction');
const { fromLegacyChapters, isExtractionImportable } = require('../lib/extraction-result');

function prose(label, count = 180) {
  return `${label} is synthetic prose with a complete sentence and a stable extraction shape. `.repeat(count);
}

function parser(config) {
  return {
    getSpine: () => config.spine,
    getToc: () => config.toc,
    getGuide: () => [],
    getMetadata: () => ({ title: 'Synthetic Kindle', author: ['Fixture Author'], language: ['en'] }),
    resolveHref: href => config.resolve[href],
    loadChapter: id => ({ html: config.chapters[id], css: [] }),
    destroy() {}
  };
}

(async () => {
  const pdf = await reprocessPdfSourceDocument({
    _pdfStructureVersion: 2,
    pageCount: 3,
    pages: [1, 2, 3].map(pageNumber => ({
      pageNumber,
      text: `CHAPTER ${pageNumber}\n\n${prose(`PDF page ${pageNumber}`)}`
    }))
  }, { warn: false, sourceLabel: 'Synthetic PDF' });
  const pdfResult = fromLegacyChapters(pdf, { sourceFormat: 'pdf', sourceDocument: pdf.sourceDocument });
  assert(isExtractionImportable(pdfResult), 'stored PDF pages traverse the real PDF rebuild extractor');
  assert(pdf[0]?.pdfExtraction?.selected === 'xbook-pdf-reprocess', 'PDF corpus records the selected extractor');

  const config = {
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
  const kindle = await extractKindleChapters('/synthetic/book.azw3', {
    format: 'azw3',
    warn: false,
    container: { available: true, extension: 'azw3', likelyKf8: true },
    parserFactories: {
      initKf8File: async () => parser(config),
      initMobiFile: async () => { throw new Error('not a MOBI file'); }
    }
  });
  const kindleResult = fromLegacyChapters(kindle, { sourceFormat: 'azw3' });
  assert(isExtractionImportable(kindleResult), 'synthetic Kindle structure traverses the real Kindle adapter');
  assert(kindle[0]?.kindleExtraction?.selected === 'kf8-primary', 'Kindle corpus records the selected parser');

  console.log('4 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
