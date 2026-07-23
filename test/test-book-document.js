const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createBookDocument } = require('../lib/book-document');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

function chapter(title = 'Chapter 1') {
  return { title, type: 'chapter', text: 'Readable prose. '.repeat(4000) };
}

function createFixture(options = {}) {
  const calls = [];
  const xbook = options.xbook || null;
  const document = createBookDocument({
    supportedFormats: new Set(['epub', 'pdf', 'mobi', 'prc', 'azw', 'azw3']),
    getXBookStore: () => xbook,
    extractEpubChapters: async source => {
      calls.push(`chapters:epub:${source}`);
      return [chapter('EPUB chapter')];
    },
    extractPdfChapters: async source => {
      calls.push(`chapters:pdf:${source}`);
      return [chapter('PDF chapter')];
    },
    extractKindleChapters: async (source, format) => {
      calls.push(`chapters:${format}:${source}`);
      return [chapter('Kindle chapter')];
    },
    extractEpubMetadata: async source => {
      calls.push(`metadata:epub:${source}`);
      return { title: 'EPUB title' };
    },
    extractPdfMetadata: async source => {
      calls.push(`metadata:pdf:${source}`);
      return { title: 'PDF title' };
    },
    extractKindleMetadata: async (source, format) => {
      calls.push(`metadata:${format}:${source}`);
      return { title: 'Kindle title' };
    },
    extractEpubCover: async (source, outputPath) => {
      calls.push(`cover:epub:${source}:${outputPath}`);
      return true;
    },
    extractKindleCover: async (source, format, outputPath) => {
      calls.push(`cover:${format}:${source}:${outputPath}`);
      return true;
    },
    splitOversizedChapters: chapters => chapters.map(item => ({ ...item, normalized: true })),
    assessExtractedContent: chapters => ({ valid: chapters.length > 0, errors: [], warnings: [] }),
    validateExtractedChapters: (chapters, validationOptions) => ({
      valid: chapters.length > 0,
      errors: [],
      warnings: [],
      validationOptions
    }),
    log: { log() {}, error() {} }
  });
  return { document, calls };
}

section('Format dispatch, metadata, and covers');

(async () => {
  const { document, calls } = createFixture();
  const epub = await document.extractChapters('/library/book.epub');
  const pdf = await document.extractChapters('/library/book.pdf');
  const kindle = await document.extractChapters('/library/book.azw3');
  assert(epub[0].normalized && pdf[0].normalized && kindle[0].normalized,
    'normalizes chapters from every format adapter');
  assert(calls.includes('chapters:epub:/library/book.epub') &&
    calls.includes('chapters:pdf:/library/book.pdf') &&
    calls.includes('chapters:azw3:/library/book.azw3'),
  'dispatches EPUB, PDF, and Kindle chapter extraction by extension');

  const metadata = await Promise.all([
    document.extractMetadata('/library/book.epub'),
    document.extractMetadata('/library/book.pdf'),
    document.extractMetadata('/library/book.mobi')
  ]);
  assert(metadata.map(item => item.title).join('|') === 'EPUB title|PDF title|Kindle title',
    'dispatches embedded metadata extraction by extension');

  assert(await document.extractCover('/library/book.epub', '/tmp/epub.jpg'),
    'extracts an EPUB embedded cover');
  assert(await document.extractCover('/library/book.azw', '/tmp/kindle.jpg'),
    'extracts a Kindle embedded cover');
  assert(await document.extractCover('/library/book.pdf', '/tmp/pdf.jpg') === false,
    'reports no embedded cover adapter for PDFs');

  let error;
  try {
    await document.extractChapters('/library/book.txt');
  } catch (err) {
    error = err;
  }
  assert(error?.message === 'Unsupported book format: unknown',
    'rejects unsupported chapter formats with the existing error message');

  section('Disk chapter cache and validation');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-book-document-'));
  const source = path.join(dir, 'cached.pdf');
  await fs.writeFile(source, 'x'.repeat(12 * 1024));
  await fs.utimes(source, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  try {
    const first = await document.getChaptersCached(source);
    const second = await document.getChaptersCached(source);
    const cachedCalls = calls.filter(call => call === `chapters:pdf:${source}`).length;
    assert(first[0].normalized && second[0].normalized && cachedCalls === 1,
      'persists and reuses chapter extraction while the source is unchanged');

    const validation = await document.validateBook(source);
    assert(validation.valid && validation.validationOptions.format === 'pdf' &&
      validation.validationOptions.fileSize === 12 * 1024,
    'validates non-EPUB books through extracted chapters with format and file size');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  section('XBook artifact adapter');
  const artifact = {
    metadata: { title: 'Stored title' },
    sourceFormat: 'PDF',
    embeddedCover: true,
    chapters: [chapter('Stored chapter')]
  };
  const { document: xbookDocument } = createFixture({
    xbook: {
      isXBookPath: source => source.endsWith('.xbook.json'),
      readXBookArtifact: async () => artifact,
      invalidateXBookArtifactCache() {}
    }
  });
  const storedChapters = await xbookDocument.extractChapters('/library/stored.xbook.json');
  const storedValidation = await xbookDocument.validateBook('/library/stored.xbook.json');
  assert(storedChapters[0].normalized && (await xbookDocument.extractMetadata('/library/stored.xbook.json')).title === 'Stored title',
    'reads chapters and metadata from XBook artifacts');
  assert(await xbookDocument.extractCover('/library/stored.xbook.json') && storedValidation.valid,
    'uses stored XBook cover state and validates stored chapters');

  console.log(`\nBook Document tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
