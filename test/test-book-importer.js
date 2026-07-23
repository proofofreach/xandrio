const { BookImportError, createBookImporter } = require('../lib/book-importer');

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

function readableChapter() {
  return { title: 'Chapter One', type: 'chapter', text: 'Readable book prose. '.repeat(3000) };
}

function createFixture(overrides = {}) {
  const {
    document: documentOverrides,
    metadata: metadataOverrides,
    ...dependencyOverrides
  } = overrides;
  const calls = [];
  const defaultDocument = {
    validateBook: async source => {
      calls.push(`validate:${source}`);
      return { valid: true, errors: [], warnings: [] };
    },
    validateExtractedChapters: chapters => ({ valid: chapters.length > 0, errors: [], warnings: [] }),
    extractMetadata: async source => {
      calls.push(`metadata:${source}`);
      return { title: 'Embedded title', author: 'Embedded author', language: 'en' };
    },
    extractChapters: async source => {
      calls.push(`chapters:${source}`);
      return [readableChapter()];
    },
    getChaptersCached: async source => {
      calls.push(`cached-chapters:${source}`);
      return [readableChapter(), readableChapter()];
    }
  };
  const defaultMetadata = {
    resolveSeed: metadata => ({
      title: metadata.title,
      author: metadata.author,
      filenameMetadata: {},
      embeddedLooksWrong: false
    }),
    enrich: async () => ({}),
    trustedTitle: () => '',
    isGarbageTitle: () => false,
    isGarbageAuthor: () => false,
    normalizeAuthor: value => value,
    resolveIdentity: async () => ({ openLibraryWorkKey: 'OL1W' }),
    assessConfidence: () => ({ warnings: [], needsReview: false }),
    buildValidation: parts => ({ valid: true, warnings: [], needsReview: false, ...parts }),
    canonicalWorkKey: (title, author) => `${title}:${author}`,
    openLibraryFields: identity => ({ openLibraryWorkKey: identity?.openLibraryWorkKey }),
    cleanDescription: value => value || '',
    publishedYear: () => undefined
  };
  const importer = createBookImporter({
    normalizeBook: async ({ sourcePath, originalName, id }) => {
      calls.push(`normalize:${sourcePath}:${id}`);
      return {
        finalPath: `/library/${id}.epub`,
        filename: `${id}.epub`,
        originalFormat: 'EPUB',
        originalSize: 12 * 1024,
        finalSize: 12 * 1024,
        largeSource: false,
        resized: false,
        originalFilename: originalName
      };
    },
    document: { ...defaultDocument, ...documentOverrides },
    checkChapterQuality: async () => ({
      isGoodStructure: true,
      reasons: [],
      contentChapters: 2,
      maxChapterSize: 20_000
    }),
    relaxValidation: async (_path, validation) => validation,
    shouldDiscardSourceAfterExtract: () => false,
    assessExtractedContent: () => ({ valid: true, errors: [], warnings: [] }),
    metadata: { ...defaultMetadata, ...metadataOverrides },
    inferGutenbergId: async () => undefined,
    ensureBookCover: async record => {
      calls.push(`cover:${record.id}`);
    },
    persistBook: async record => {
      calls.push(`persist:${record.id}`);
      return { record };
    },
    removeFile: async filePath => {
      calls.push(`remove:${filePath}`);
    },
    writeArtifact: async () => {},
    path: { basename: value => value.split('/').pop() },
    now: () => '2026-07-11T00:00:00.000Z',
    log: { log() {}, warn() {}, error() {} },
    ...dependencyOverrides
  });
  return { importer, calls };
}

function command(overrides = {}) {
  return {
    kind: 'upload',
    id: 'book-1',
    originalName: 'book.epub',
    sourcePath: '/uploads/book.epub',
    selected: { title: null, author: null, language: 'en' },
    downloadSource: 'upload',
    ...overrides
  };
}

section('Successful direct import');

(async () => {
  const { importer, calls } = createFixture();
  const progress = [];
  const result = await importer.import(command(), (step, detail) => progress.push([step, detail]));
  assert(result.book.id === 'book-1' && result.book.title === 'Embedded title',
    'returns the persisted book record without HTTP request or response objects');
  assert(/^v1-[a-f0-9]{20}$/.test(result.book.chapterStructureKey),
    'persists a stable chapter-structure identity with new imports');
  assert(result.book.sourceProvenance?.provider === 'upload' &&
    result.book.sourceProvenance?.rightsStatus === 'operator-supplied' &&
    result.book.sourceProvenance?.acquiredAt === '2026-07-11T00:00:00.000Z',
  'records privacy-safe source provenance for an operator upload');
  assert(calls.includes('normalize:/uploads/book.epub:book-1') &&
    calls.includes('validate:/library/book-1.epub') &&
    calls.includes('persist:book-1'),
  'normalizes, validates, and persists the source through one command');
  assert(progress.some(([step]) => step === 3) && progress.some(([step]) => step === 7),
    'reports import progress across the shared pipeline');

  const normalizedAuthor = createFixture({
    document: {
      extractMetadata: async () => ({ title: 'Revelations of Christ', author: 'Yogananda, Paramhansa', language: 'en' })
    },
    metadata: {
      normalizeAuthor: value => value === 'Yogananda, Paramhansa' ? 'Paramhansa Yogananda' : value
    }
  });
  const normalizedAuthorResult = await normalizedAuthor.importer.import(command());
  assert(normalizedAuthorResult.book.author === 'Paramhansa Yogananda',
    'normalizes catalog-order embedded author names before persistence');

  const downloaded = createFixture();
  const downloadedResult = await downloaded.importer.import(command({
    kind: 'download',
    downloadSource: 'internetarchive',
    sourceProvenance: {
      itemId: 'archive-item-1',
      sourceUrl: 'https://archive.org/details/archive-item-1?temporary=secret#page=1',
      reportedLicense: 'CC BY 4.0'
    }
  }));
  assert(downloadedResult.book.sourceProvenance?.provider === 'internetarchive' &&
    downloadedResult.book.sourceProvenance?.itemId === 'archive-item-1' &&
    downloadedResult.book.sourceProvenance?.sourceUrl === 'https://archive.org/details/archive-item-1' &&
    downloadedResult.book.sourceProvenance?.reportedLicense === 'CC BY 4.0',
  'records provider identity and strips query credentials from downloaded-book provenance');

  section('Validation cleanup');
  const invalid = createFixture({
    document: {
      validateBook: async () => ({ valid: false, errors: ['bad document'], warnings: ['damaged'] }),
      validateExtractedChapters: () => ({ valid: false, errors: ['bad document'], warnings: ['damaged'] }),
      extractMetadata: async () => ({}),
      extractChapters: async () => [],
      getChaptersCached: async () => []
    }
  });
  let validationError;
  try {
    await invalid.importer.import(command());
  } catch (error) {
    validationError = error;
  }
  assert(validationError instanceof BookImportError && validationError.response.error === 'Book validation failed',
    'returns a typed validation error with the existing public upload response');
  assert(invalid.calls.includes('remove:/library/book-1.epub'),
    'cleans up a normalized source that fails validation');

  section('Candidate preparation cleanup');
  const validationException = createFixture({
    document: {
      validateBook: async () => {
        throw new Error('validator unavailable');
      }
    }
  });
  let validationExceptionError;
  try {
    await validationException.importer.import(command());
  } catch (error) {
    validationExceptionError = error;
  }
  assert(validationExceptionError?.message === 'validator unavailable',
    'preserves validator exceptions raised after normalization');
  assert(validationException.calls.includes('remove:/library/book-1.epub'),
    'cleans up a normalized source when validation throws');

  const alternativeFailure = createFixture({
    normalizeBook: async ({ sourcePath, id }) => ({
      finalPath: `/library/${sourcePath.includes('alternative') ? 'alternative' : id}.epub`,
      filename: `${id}.epub`, originalFormat: 'EPUB', originalSize: 12 * 1024,
      finalSize: 12 * 1024, largeSource: false, resized: false
    }),
    document: {
      validateBook: async source => {
        if (source.includes('alternative')) throw new Error('alternative validator unavailable');
        return { valid: true, errors: [], warnings: [] };
      }
    },
    checkChapterQuality: async source => source.includes('alternative')
      ? { isGoodStructure: true, reasons: [], contentChapters: 2, maxChapterSize: 20_000 }
      : { isGoodStructure: false, reasons: ['weak structure'], contentChapters: 1, maxChapterSize: 20_000 }
  });
  const alternativeFailureResult = await alternativeFailure.importer.import(command({
    alternatives: [{
      id: 'alternative',
      originalName: 'alternative.epub',
      sourcePath: '/uploads/alternative.epub'
    }]
  }));
  assert(alternativeFailureResult.book.id === 'book-1',
    'continues importing the viable primary candidate after an alternative preparation failure');
  assert(alternativeFailure.calls.includes('remove:/library/alternative.epub'),
    'cleans up a normalized alternative when its preparation throws');
  assert(!alternativeFailure.calls.includes('remove:/uploads/alternative.epub'),
    'does not delete an alternative command source path during cleanup');

  section('Late failure cleanup');
  const enrichmentFailure = createFixture({
    metadata: {
      enrich: async () => {
        throw new Error('metadata service unavailable');
      }
    }
  });
  let enrichmentError;
  try {
    await enrichmentFailure.importer.import(command());
  } catch (error) {
    enrichmentError = error;
  }
  assert(enrichmentError?.message === 'metadata service unavailable',
    'preserves enrichment failures after candidate validation');
  assert(enrichmentFailure.calls.includes('remove:/library/book-1.epub'),
    'cleans up the normalized source when metadata enrichment fails');
  assert(!enrichmentFailure.calls.includes('remove:/uploads/book.epub'),
    'never deletes the command source path while cleaning an owned normalized file');

  const artifactFailure = createFixture({
    shouldDiscardSourceAfterExtract: () => true,
    createArtifact: async () => ({
      xbookPath: '/library/book-1.xbook.json',
      artifact: { metadata: { title: 'Embedded title', author: 'Embedded author' } }
    }),
    metadata: {
      enrich: async () => {
        throw new Error('metadata service unavailable');
      }
    }
  });
  try {
    await artifactFailure.importer.import(command());
  } catch {}
  assert(artifactFailure.calls.includes('remove:/library/book-1.epub') &&
    artifactFailure.calls.includes('remove:/library/book-1.xbook.json'),
  'cleans up both the replaced source and generated artifact after a late failure');

  const persistenceFailure = createFixture({
    persistBook: async () => {
      throw new Error('library write failed');
    }
  });
  let persistenceError;
  try {
    await persistenceFailure.importer.import(command());
  } catch (error) {
    persistenceError = error;
  }
  assert(persistenceError?.message === 'library write failed',
    'preserves persistence failures after enrichment and cover lookup');
  assert(persistenceFailure.calls.includes('remove:/library/book-1.epub'),
    'cleans up the normalized source when persistence fails');

  const postPersistFailure = createFixture({
    afterPersist: async () => {
      throw new Error('post-persist work failed');
    }
  });
  let postPersistError;
  try {
    await postPersistFailure.importer.import(command());
  } catch (error) {
    postPersistError = error;
  }
  assert(postPersistError?.message === 'post-persist work failed',
    'preserves failures raised after persistence commits');
  assert(!postPersistFailure.calls.includes('remove:/library/book-1.epub'),
    'retains the committed book when post-persistence work fails');

  section('Duplicate cleanup');
  const duplicate = createFixture({
    persistBook: async () => ({ existingBook: { id: 'existing', title: 'Existing book', author: 'Author' } })
  });
  let duplicateError;
  try {
    await duplicate.importer.import(command());
  } catch (error) {
    duplicateError = error;
  }
  assert(duplicateError instanceof BookImportError && duplicateError.existingBookId === 'existing',
    'returns duplicate details for thin HTTP adapters');
  assert(duplicate.calls.includes('remove:/library/book-1.epub'),
    'removes the duplicate source after persistence rejects it');

  section('Alternative candidate selection');
  const filteredAlternative = createFixture({
    checkChapterQuality: async source => source.includes('primary')
      ? { isGoodStructure: false, reasons: ['poor structure'], contentChapters: 0, maxChapterSize: 200_000 }
      : { isGoodStructure: true, reasons: [], contentChapters: 3, maxChapterSize: 20_000 }
  });
  const filteredProgress = [];
  await filteredAlternative.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [
      { id: 'unsafe', originalName: 'unsafe.epub', sourcePath: '/uploads/unsafe.epub', shouldTry: async () => false },
      { id: 'safe', originalName: 'safe.epub', sourcePath: '/uploads/safe.epub', shouldTry: async () => true }
    ]
  }), (step, detail) => filteredProgress.push([step, detail]));
  assert(filteredProgress.some(([, detail]) => detail === 'Trying alternative version 1 of 1'),
    'reports the filtered automatic fallback count instead of counting unsafe versions');
  assert(!filteredAlternative.calls.some(call => call.includes('/uploads/unsafe.epub')),
    'does not prepare an automatic alternative that fails compatibility checks');

  const alternative = createFixture({
    checkChapterQuality: async source => source.includes('primary')
      ? { isGoodStructure: false, reasons: ['poor structure'], contentChapters: 0, maxChapterSize: 200_000 }
      : { isGoodStructure: true, reasons: [], contentChapters: 3, maxChapterSize: 20_000 },
    normalizeBook: async ({ sourcePath, id }) => ({
      finalPath: `/library/${sourcePath.includes('alternative') ? 'alternative' : 'primary'}.epub`,
      filename: `${id}.epub`, originalFormat: 'EPUB', originalSize: 12 * 1024,
      finalSize: 12 * 1024, largeSource: false, resized: false
    })
  });
  const alternativeResult = await alternative.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [{
      id: 'alternative',
      originalName: 'alternative.epub',
      sourcePath: '/uploads/alternative.epub',
      selected: { title: 'Alternative title', author: 'Alternative author' },
      source: 'gutenberg',
      sourceProvenance: {
        itemId: 'pg-alternative',
        sourceUrl: 'https://www.gutenberg.org/ebooks/123'
      }
    }]
  }));
  assert(alternativeResult.usedAlternative && alternativeResult.book.id === 'alternative',
    'selects a better alternative through the same import command');
  assert(alternativeResult.book.sourceProvenance?.provider === 'gutenberg' &&
    alternativeResult.book.sourceProvenance?.itemId === 'pg-alternative',
  'records provenance for the edition that was actually imported');

  console.log(`\nBook Importer tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
