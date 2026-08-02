const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createBookDocument } = require('../lib/book-document');
const { createXBookStore } = require('../lib/xbook-store');
const {
  buildChapterIndexMap,
  remapBookPositions,
  remapBookBookmarks
} = require('../lib/chapter-reprocess');

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
      const chapters = [chapter('PDF chapter')];
      if (options.pdfSourceDocument) {
        Object.defineProperty(chapters, 'sourceDocument', {
          value: options.pdfSourceDocument,
          enumerable: false
        });
      }
      return chapters;
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

  const sourceDocumentFixture = createFixture({
    pdfSourceDocument: { _pdfStructureVersion: 2, pages: [{ pageNumber: 1, text: 'Source page' }] }
  });
  const sourceDocumentChapters = await sourceDocumentFixture.document.extractChapters('/library/source-data.pdf');
  assert(sourceDocumentChapters.sourceDocument?._pdfStructureVersion === 2,
    'preserves PDF reprocessing data through chapter normalization');

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
    await fs.writeFile(path.join(dir, 'cached.chapters.json'), JSON.stringify({
      _cacheVersion: 24,
      chapters: [chapter('Stale version-24 chapter')]
    }));
    const first = await document.getChaptersCached(source);
    const second = await document.getChaptersCached(source);
    const cachedCalls = calls.filter(call => call === `chapters:pdf:${source}`).length;
    assert(first[0].title === 'PDF chapter' && first[0].normalized && second[0].normalized && cachedCalls === 1,
      'regenerates version-24 chapter caches, then reuses the current extraction');

    const validation = await document.validateBook(source);
    assert(validation.valid && validation.validationOptions.format === 'pdf' &&
      validation.validationOptions.fileSize === 12 * 1024,
    'validates non-EPUB books through extracted chapters with format and file size');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  section('Complete short EPUB validation');
  const shortChapterLengths = [
    0, 0, 0, 0,
    5334, 5334, 5334, 5334, 5334, 5334, 5334, 5334, 5338,
    0
  ];
  const shortFlow = shortChapterLengths.map((_, index) => ({ id: `item-${index}` }));
  const completeShortDocument = createBookDocument({
    fs: {
      stat: async () => ({ size: 600 * 1024 })
    },
    fsSync: {
      existsSync: () => true,
      statSync: () => ({ size: 600 * 1024 })
    },
    execFileAsync: async () => {},
    createEpub: async () => ({
      metadata: { title: 'As a Man Thinketh' },
      toc: shortFlow,
      flow: shortFlow
    }),
    getEpubChapterText: async (_epub, id) => {
      const index = Number(id.replace('item-', ''));
      return 'x'.repeat(shortChapterLengths[index]);
    },
    log: { log() {}, error() {} }
  });
  const completeShortValidation = await completeShortDocument.validateBook('/library/as-a-man-thinketh.epub');
  assert(completeShortValidation.valid,
    'accepts the complete 48,010-character As a Man Thinketh EPUB');
  assert(completeShortValidation.warnings.some(warning => warning.includes('48,010')),
    'warns that the accepted EPUB is shorter than a typical book');

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

  section('Versioned XBook PDF source data');
  const xbookDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-xbook-'));
  try {
    const store = createXBookStore({
      cacheDir: xbookDir,
      xbookVersion: 2,
      deleteSourceAfterExtract: true,
      getFileIdentity: async filePath => {
        const stat = await fs.stat(filePath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      invalidateFileIdentity() {},
      extractBookMetadata: async () => ({}),
      extractBookChapters: async () => [],
      extractMobiCover: async () => false,
      getBookFormatFromName: () => 'pdf',
      reprocessPdfDocument: async sourceDocument => {
        const chapters = [chapter('Reprocessed chapter')];
        Object.defineProperty(chapters, 'sourceDocument', {
          value: { ...sourceDocument, reprocessedAt: '2026-07-27T00:00:00.000Z' },
          enumerable: false
        });
        return chapters;
      }
    });
    const persistedChapters = [chapter('Persisted PDF chapter')];
    Object.defineProperty(persistedChapters, 'sourceDocument', {
      value: { _pdfStructureVersion: 2, pages: [{ pageNumber: 1, text: 'Persisted source text' }] },
      enumerable: false
    });
    const written = await store.writeXBookArtifact('pdf-book', '/library/pdf-book.pdf', {
      originalFormat: 'PDF',
      chapters: persistedChapters
    });
    const reloaded = await store.readXBookArtifact(written.xbookPath);
    assert(reloaded.sourceDocument?._pdfStructureVersion === 2,
      'persists PDF page data separately from narrated chapters');
    const reprocessedArtifact = await store.reprocessXBookArtifact(written.xbookPath);
    assert(reprocessedArtifact.chapters[0].title === 'Reprocessed chapter' &&
      reprocessedArtifact.sourceDocument.reprocessedAt,
    'rewrites XBook chapters from persisted PDF page data');

    const legacyPath = path.join(xbookDir, 'legacy.xbook.json');
    await fs.writeFile(legacyPath, JSON.stringify({
      _xbookVersion: 1,
      id: 'legacy',
      sourceFormat: 'PDF',
      metadata: {},
      chapters: [chapter('Legacy chapter')]
    }));
    assert((await store.readXBookArtifact(legacyPath)).id === 'legacy',
      'keeps existing version-one XBook artifacts readable after the version bump');
  } finally {
    await fs.rm(xbookDir, { recursive: true, force: true });
  }

  section('PDF chapter state remapping');
  const previousChapters = [
    { title: 'Pages 1-20', pageStart: 1, pageEnd: 20 },
    { title: 'Pages 21-40', pageStart: 21, pageEnd: 40 },
    { title: 'Pages 41-60', pageStart: 41, pageEnd: 60 }
  ];
  const authoredChapters = [
    { title: 'Introduction', pageStart: 5, pageEnd: 12 },
    { title: 'Chapter 1: First Steps', pageStart: 13, pageEnd: 31 },
    { title: 'Chapter 2: Going Further', pageStart: 32, pageEnd: 60 }
  ];
  const chapterIndexMap = buildChapterIndexMap(previousChapters, authoredChapters);
  assert(JSON.stringify(chapterIndexMap) === JSON.stringify([0, 1, 2]),
    'maps legacy page groups to authored chapter ranges');

  const positions = {
    users: {
      reader: {
        book: { chapterIndex: 1, timestamp: 120, chunkIndex: 3, chunkTime: 10 }
      }
    }
  };
  remapBookPositions(positions, 'book', chapterIndexMap, 'v1-new');
  assert(positions.users.reader.book.chapterIndex === 1 &&
    positions.users.reader.book.timestamp === 0 &&
    positions.users.reader.book.chapterStructureKey === 'v1-new' &&
    positions.users.reader.book.chunkIndex === undefined,
  'remaps playback positions and clears stale within-chapter anchors');

  const bookmarks = {
    users: {
      reader: {
        book: [{ id: 'bm-1', chapterIndex: 2, timestamp: 15 }]
      }
    }
  };
  remapBookBookmarks(bookmarks, 'book', chapterIndexMap);
  assert(bookmarks.users.reader.book[0].chapterIndex === 2 &&
    bookmarks.users.reader.book[0].timestamp === 0,
  'remaps bookmarks and clears stale within-chapter anchors');

  console.log(`\nBook Document tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
