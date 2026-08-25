const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createBookDocument } = require('../lib/book-document');
const { createXBookStore } = require('../lib/xbook-store');
const { ALLOWED_TEXT_MUTATIONS, attachMutationActivations } = require('../lib/extraction-result');
const {
  buildChapterIndexMap,
  buildChapterTransition,
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
      const chapters = [chapter('EPUB chapter')];
      if (options.epubMutations) attachMutationActivations(chapters, options.epubMutations);
      return chapters;
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

  const extractionResult = await sourceDocumentFixture.document.extractResult('/library/source-data.pdf');
  assert(extractionResult.sourceFormat === 'pdf' &&
    extractionResult.sourceDocument?._pdfStructureVersion === 2 &&
    extractionResult.chapters.extractionResult === extractionResult,
  'exposes one extraction result while preserving the chapter-array adapter');

  const mutationFixture = createFixture({
    epubMutations: [{
      code: ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL.code,
      count: 2
    }]
  });
  const normalizedResult = await mutationFixture.document.extractResult('/library/mutations.epub');
  assert(normalizedResult.mutations.some(mutation =>
    mutation.code === ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL.code && mutation.count === 2),
  'preserves extractor-site mutation activations through document normalization');

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

    let generationCalls = 0;
    const generationSource = path.join(dir, 'generation.pdf');
    await fs.writeFile(generationSource, 'generation source');
    const generationDocument = createBookDocument({
      supportedFormats: new Set(['pdf']),
      extractPdfChapters: async () => {
        generationCalls++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return [chapter('Generated once')];
      },
      log: { log() {}, error() {} }
    });
    const generated = await Promise.all(Array.from(
      { length: 12 },
      () => generationDocument.getChaptersCached(generationSource)
    ));
    assert(generationCalls === 1 && generated.every(chapters => chapters[0].title === 'Generated once'),
      'deduplicates concurrent chapter cache generation by cache path');

    const atomicSource = path.join(dir, 'atomic.pdf');
    const atomicCache = path.join(dir, 'atomic.chapters.json');
    await fs.writeFile(atomicSource, 'atomic source');
    await fs.utimes(atomicSource, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const originalCache = JSON.stringify({
      _cacheVersion: 28,
      chapters: [chapter('Existing cache')]
    });
    await fs.writeFile(atomicCache, originalCache);

    const writerCount = 8;
    let writersStarted = 0;
    let releaseWrites;
    let signalWritersReady;
    const writersReady = new Promise(resolve => {
      signalWritersReady = resolve;
    });
    const writesReleased = new Promise(resolve => {
      releaseWrites = resolve;
    });
    const delayedFileSystem = Object.create(fs);
    delayedFileSystem.writeFile = async (filePath, data, options) => {
      const isCacheWrite = filePath === atomicCache ||
        path.basename(filePath).startsWith(`.${path.basename(atomicCache)}.`);
      if (!isCacheWrite) return fs.writeFile(filePath, data, options);
      const midpoint = Math.floor(data.length / 2);
      await fs.writeFile(filePath, data.slice(0, midpoint), options);
      writersStarted++;
      if (writersStarted === writerCount) signalWritersReady();
      await writesReleased;
      await fs.appendFile(filePath, data.slice(midpoint));
    };
    const staleCacheIdentity = async filePath => {
      const stat = await fs.stat(filePath);
      return filePath === atomicCache
        ? { mtimeMs: 0, size: stat.size }
        : { mtimeMs: stat.mtimeMs, size: stat.size };
    };
    const writers = Array.from({ length: writerCount }, (_, index) => {
      const writer = createBookDocument({
        fs: delayedFileSystem,
        supportedFormats: new Set(['pdf']),
        getFileIdentity: staleCacheIdentity,
        extractPdfChapters: async () => [chapter(`Writer ${index}`)],
        log: { log() {}, error() {} }
      });
      return writer.getChaptersCached(atomicSource);
    });
    await writersReady;
    let readerExtractions = 0;
    const readerResults = await Promise.all(Array.from({ length: 24 }, async () => {
      const reader = createBookDocument({
        supportedFormats: new Set(['pdf']),
        extractPdfChapters: async () => {
          readerExtractions++;
          return [chapter('Unexpected reader extraction')];
        },
        log: { log() {}, error() {} }
      });
      return reader.getChaptersCached(atomicSource);
    }));
    releaseWrites();
    await Promise.all(writers);
    const finalCache = JSON.parse(await fs.readFile(atomicCache, 'utf8'));
    assert(
      readerExtractions === 0 &&
      readerResults.every(chapters => chapters[0].title === 'Existing cache') &&
      /^Writer \d+$/.test(finalCache.chapters[0].title),
      'keeps concurrent readers from observing partial chapter-cache JSON');

    const interruptedSource = path.join(dir, 'interrupted.pdf');
    const interruptedCache = path.join(dir, 'interrupted.chapters.json');
    await fs.writeFile(interruptedSource, 'interrupted source');
    await fs.utimes(interruptedSource, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await fs.writeFile(interruptedCache, originalCache);
    const interruptedFileSystem = Object.create(fs);
    interruptedFileSystem.writeFile = async (filePath, data, options) => {
      const isCacheWrite = filePath === interruptedCache ||
        path.basename(filePath).startsWith(`.${path.basename(interruptedCache)}.`);
      if (!isCacheWrite) return fs.writeFile(filePath, data, options);
      await fs.writeFile(filePath, data.slice(0, Math.floor(data.length / 2)), options);
      throw new Error('simulated interrupted cache write');
    };
    const interruptedDocument = createBookDocument({
      fs: interruptedFileSystem,
      supportedFormats: new Set(['pdf']),
      getFileIdentity: async filePath => {
        const stat = await fs.stat(filePath);
        return filePath === interruptedCache
          ? { mtimeMs: 0, size: stat.size }
          : { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      extractPdfChapters: async () => [chapter('Interrupted write result')],
      log: { log() {}, error() {} }
    });
    await interruptedDocument.getChaptersCached(interruptedSource);
    assert(
      await fs.readFile(interruptedCache, 'utf8') === originalCache &&
      (await fs.readdir(dir)).every(name => !name.startsWith(`.${path.basename(interruptedCache)}.`)),
      'preserves the prior chapter cache when a cache write is interrupted');

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
    assert(reloaded.processingVersion === 1,
      'new XBook artifacts record the extraction processing version');
    const rebuildPlan = await store.planXBookRebuild(written.xbookPath);
    assert(rebuildPlan.safe && rebuildPlan.candidate.chapters[0].title === 'Reprocessed chapter',
      'plans a text-conserving rebuild without mutating the artifact');
    assert((await store.readXBookArtifact(written.xbookPath)).chapters[0].title === 'Persisted PDF chapter',
      'a rebuild plan is a dry run until a transaction commits it');
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
    assert((await store.readXBookArtifact(legacyPath)).processingVersion === undefined,
      'treats a missing legacy processing version in memory without rewriting on read');

    const retainedMobiPath = path.join(xbookDir, 'retained.mobi');
    const retainedXBookPath = path.join(xbookDir, 'retained.xbook.json');
    await fs.writeFile(retainedMobiPath, 'synthetic MOBI container');
    await fs.writeFile(retainedXBookPath, JSON.stringify({
      _xbookVersion: 2,
      id: 'retained',
      sourceFormat: 'MOBI',
      sourceDeleted: false,
      sourcePath: retainedMobiPath,
      metadata: {},
      chapters: [chapter('Chapter 1')]
    }));
    const retainedStore = createXBookStore({
      cacheDir: xbookDir,
      xbookVersion: 2,
      deleteSourceAfterExtract: true,
      getFileIdentity: async filePath => {
        const stat = await fs.stat(filePath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      invalidateFileIdentity() {},
      extractBookMetadata: async () => ({}),
      extractBookChapters: async sourcePath => {
        assert(sourcePath === retainedMobiPath,
          'rebuilds a retained Kindle artifact from its canonical cache source');
        return [chapter('Authored story title')];
      },
      extractMobiCover: async () => false,
      getBookFormatFromName: filePath => path.extname(filePath).slice(1).toLowerCase()
    });
    assert(await retainedStore.canRebuildXBookArtifact(retainedXBookPath),
      'advertises chapter rebuild for an available retained Kindle source');
    const retainedPlan = await retainedStore.planXBookRebuild(retainedXBookPath);
    assert(retainedPlan.safe && retainedPlan.changed &&
      retainedPlan.candidate.chapters[0].title === 'Authored story title',
    'plans a text-conserving retained-Kindle rebuild without mutating the artifact');

    const legacySplitPath = path.join(xbookDir, 'legacy-split.xbook.json');
    const legacyTextParts = ['Legacy punctuation.One', 'Legacy punctuation.Two'];
    await fs.writeFile(legacySplitPath, JSON.stringify({
      _xbookVersion: 2,
      id: 'legacy-split',
      sourceFormat: 'MOBI',
      sourceDeleted: false,
      sourcePath: retainedMobiPath,
      metadata: {},
      chapters: legacyTextParts.map((text, index) => ({
        title: `Chapter 1 — Part ${index + 1} of 2`,
        type: 'chapter',
        text,
        estimatedDuration: 10,
        originalIndex: 4,
        sourceSpineId: 'filepos:400'
      }))
    }));
    const legacySplitStore = createXBookStore({
      cacheDir: xbookDir,
      xbookVersion: 2,
      deleteSourceAfterExtract: true,
      getFileIdentity: async filePath => {
        const stat = await fs.stat(filePath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      invalidateFileIdentity() {},
      extractBookMetadata: async () => ({}),
      extractBookChapters: async () => [{
        title: 'Recovered authored title',
        type: 'chapter',
        text: 'Legacy punctuation. One Legacy punctuation. Two',
        estimatedDuration: 20,
        originalIndex: 4,
        sourceSpineId: 'filepos:400',
        fromToc: true,
        authoredBoundary: true
      }],
      extractMobiCover: async () => false,
      getBookFormatFromName: filePath => path.extname(filePath).slice(1).toLowerCase()
    });
    const legacySplitPlan = await legacySplitStore.planXBookRebuild(legacySplitPath);
    assert(legacySplitPlan.safe && legacySplitPlan.narrationPreserved &&
      legacySplitPlan.candidate.chapters.length === 1 &&
      legacySplitPlan.candidate.chapters[0].title === 'Recovered authored title' &&
      legacySplitPlan.candidate.chapters[0].text === legacyTextParts.join(' '),
    'recovers retained-Kindle structure while preserving legacy split narration exactly');

    const punctuationDriftPath = path.join(xbookDir, 'punctuation-drift.xbook.json');
    await fs.writeFile(punctuationDriftPath, JSON.stringify({
      _xbookVersion: 2,
      id: 'punctuation-drift',
      sourceFormat: 'MOBI',
      sourceDeleted: false,
      sourcePath: retainedMobiPath,
      metadata: {},
      chapters: [
        { title: 'Chapter 1', type: 'chapter', text: 'ALPHA prose.One', estimatedDuration: 10 },
        { title: 'Chapter 2', type: 'chapter', text: 'BETA prose.Two', estimatedDuration: 10 }
      ]
    }));
    const punctuationDriftStore = createXBookStore({
      cacheDir: xbookDir,
      xbookVersion: 2,
      deleteSourceAfterExtract: true,
      getFileIdentity: async filePath => {
        const stat = await fs.stat(filePath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      invalidateFileIdentity() {},
      extractBookMetadata: async () => ({}),
      extractBookChapters: async () => [
        { title: 'First authored title', type: 'chapter', text: 'Alpha prose. One beta', estimatedDuration: 10 },
        { title: 'Second authored title', type: 'chapter', text: 'prose. Two', estimatedDuration: 10 }
      ],
      extractMobiCover: async () => false,
      getBookFormatFromName: filePath => path.extname(filePath).slice(1).toLowerCase()
    });
    const punctuationDriftPlan = await punctuationDriftStore.planXBookRebuild(punctuationDriftPath);
    assert(punctuationDriftPlan.safe && punctuationDriftPlan.narrationPreserved &&
      punctuationDriftPlan.candidate.chapters.map(item => item.text).join(' ') ===
        'ALPHA prose.One BETA prose.Two' &&
      punctuationDriftPlan.candidate.chapters[0].title === 'First authored title',
    'adopts fresh Kindle structure when ordered words match despite legacy case and punctuation drift');

    const unidentifiedPath = path.join(xbookDir, 'unidentified.xbook.json');
    await fs.writeFile(unidentifiedPath, JSON.stringify({
      _xbookVersion: 2,
      id: 'unidentified',
      sourceFormat: 'MOBI',
      sourceDeleted: false,
      sourcePath: retainedMobiPath,
      metadata: {},
      chapters: [{
        title: 'Chapter 1',
        type: 'chapter',
        text: 'Old narration',
        originalIndex: 4,
        sourceSpineId: 'filepos:400'
      }]
    }));
    const unidentifiedPlan = await legacySplitStore.planXBookRebuild(unidentifiedPath);
    assert(!unidentifiedPlan.safe && !unidentifiedPlan.narrationPreserved,
      'refuses narration preservation when the ordered narration words change');
  } finally {
    await fs.rm(xbookDir, { recursive: true, force: true });
  }

  section('PDF chapter state remapping');
  const previousChapters = [
    { title: 'Pages 1-20', pageStart: 1, pageEnd: 20, text: 'Alpha prose. '.repeat(100), estimatedDuration: 100 },
    { title: 'Pages 21-40', pageStart: 21, pageEnd: 40, text: 'Beta prose. '.repeat(100), estimatedDuration: 100 },
    { title: 'Pages 41-60', pageStart: 41, pageEnd: 60, text: 'Gamma prose. '.repeat(100), estimatedDuration: 100 }
  ];
  const authoredChapters = [
    { title: 'Introduction', pageStart: 5, pageEnd: 12, text: previousChapters[0].text, estimatedDuration: 100 },
    { title: 'Chapter 1: First Steps', pageStart: 13, pageEnd: 31, text: previousChapters[1].text, estimatedDuration: 100 },
    { title: 'Chapter 2: Going Further', pageStart: 32, pageEnd: 60, text: previousChapters[2].text, estimatedDuration: 100 }
  ];
  const chapterIndexMap = buildChapterIndexMap(previousChapters, authoredChapters);
  assert(JSON.stringify(chapterIndexMap) === JSON.stringify([0, 1, 2]),
    'maps legacy page groups to authored chapter ranges');

  const positions = {
    users: {
      reader: {
        book: { chapterIndex: 1, timestamp: 50, chunkIndex: 3, chunkTime: 10 }
      }
    }
  };
  const transition = buildChapterTransition(previousChapters, authoredChapters);
  assert(transition.safe, 'builds a safe character-offset transition when narration text is conserved');
  remapBookPositions(positions, 'book', transition, 'v1-new');
  assert(positions.users.reader.book.chapterIndex === 1 &&
    positions.users.reader.book.timestamp === 50 &&
    positions.users.reader.book.chapterStructureKey === 'v1-new' &&
    positions.users.reader.book.chunkIndex === 3,
  'remaps playback positions without resetting time or unchanged chunk anchors');

  const bookmarks = {
    users: {
      reader: {
        book: [{ id: 'bm-1', chapterIndex: 2, timestamp: 25 }]
      }
    }
  };
  remapBookBookmarks(bookmarks, 'book', transition);
  assert(bookmarks.users.reader.book[0].chapterIndex === 2 &&
    bookmarks.users.reader.book[0].timestamp === 25,
  'remaps bookmarks without resetting their within-chapter position');

  const unsafeTransition = buildChapterTransition(previousChapters, authoredChapters.slice(0, 2));
  assert(!unsafeTransition.safe && unsafeTransition.reason === 'narration-text-mismatch',
    'refuses a transition that loses narration text');

  console.log(`\nBook Document tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
