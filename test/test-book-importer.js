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
      structureVerified: true,
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
    writeArtifactData: async filePath => {
      calls.push(`write-artifact:${filePath}`);
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

  const calibreImport = createFixture({
    metadata: {
      publishedYear: value => value ? 2024 : undefined
    }
  });
  const calibreResult = await calibreImport.importer.import(command({
    kind: 'calibre',
    downloadSource: 'calibre',
    catalogMetadata: {
      title: 'Catalog Title',
      author: 'Catalog Author',
      publisher: 'Catalog Press',
      publishedDate: '2024-03-01',
      description: 'Catalog description',
      tags: ['History', 'Research'],
      language: 'fr',
      isbn: '9780000000001',
      series: 'Catalog Series',
      seriesIndex: 3
    },
    calibre: {
      libraryUuid: 'library-a',
      bookUuid: 'book-a',
      calibreId: '42',
      lastModified: '2026-08-16T12:00:00Z'
    },
    sourceProvenance: { itemId: 'library-a:book-a' }
  }));
  assert(calibreResult.book.title === 'Catalog Title' &&
    calibreResult.book.author === 'Catalog Author' &&
    calibreResult.book.publisher === 'Catalog Press' &&
    calibreResult.book.publishedDate === 2024 &&
    calibreResult.book.description === 'Catalog description' &&
    calibreResult.book.language === 'fr' &&
    calibreResult.book.isbn === '9780000000001' &&
    calibreResult.book.series === 'Catalog Series' &&
    calibreResult.book.seriesIndex === 3 &&
    calibreResult.book.subjects.join(',') === 'History,Research' &&
    calibreResult.book.calibre.bookUuid === 'book-a',
  'preserves authoritative Calibre metadata and stable external identity');
  assert(calibreResult.book.sourceProvenance?.provider === 'calibre' &&
    calibreResult.book.sourceProvenance?.itemId === 'library-a:book-a' &&
    calibreResult.book.sourceProvenance?.rightsStatus === 'operator-supplied',
  'records Calibre as an operator-supplied source');

  const clearedCalibreImport = createFixture({
    document: {
      extractMetadata: async () => ({
        title: 'Embedded title', author: 'Embedded author', publisher: 'Embedded Press',
        description: 'Embedded description', isbn: 'embedded-isbn', language: 'en'
      })
    },
    metadata: { enrich: async () => ({ subjects: ['Embedded subject'] }) }
  });
  const clearedCalibreResult = await clearedCalibreImport.importer.import(command({
    kind: 'calibre',
    downloadSource: 'calibre',
    catalogMetadata: {
      title: 'Catalog Title', author: 'Catalog Author', publisher: null,
      description: null, tags: [], isbn: null, series: null, seriesIndex: null
    }
  }));
  assert(clearedCalibreResult.book.publisher === undefined &&
    clearedCalibreResult.book.description === '' &&
    clearedCalibreResult.book.isbn === undefined &&
    clearedCalibreResult.book.series === undefined &&
    clearedCalibreResult.book.seriesIndex === undefined &&
    clearedCalibreResult.book.subjects.length === 0,
  'preserves authoritative empty Calibre metadata instead of restoring embedded values');

  section('Review-needed PDF retention');
  const reviewChapters = [readableChapter(), readableChapter()];
  reviewChapters[0].pdfExtraction = {
    status: 'review-needed',
    score: 72,
    structure: { mode: 'page-groups', confidence: 0 }
  };
  Object.defineProperty(reviewChapters, 'sourceDocument', {
    value: { _pdfStructureVersion: 2, pages: [{ pageNumber: 1, text: 'Source text' }] },
    enumerable: false
  });
  let artifactSourceInfo;
  const reviewPdf = createFixture({
    normalizeBook: async ({ id }) => ({
      finalPath: `/library/${id}.pdf`,
      filename: `${id}.pdf`,
      originalFormat: 'PDF',
      originalSize: 12 * 1024,
      finalSize: 12 * 1024,
      largeSource: false,
      resized: false
    }),
    document: {
      extractChapters: async () => reviewChapters
    },
    shouldDiscardSourceAfterExtract: () => true,
    createArtifact: async (_id, _source, sourceInfo) => {
      artifactSourceInfo = sourceInfo;
      return {
        xbookPath: '/library/book-1.xbook.json',
        artifact: {
          metadata: { title: 'Embedded title', author: 'Embedded author', language: 'en' },
          chapters: reviewChapters
        }
      };
    }
  });
  const reviewPdfResult = await reviewPdf.importer.import(command({
    originalName: 'book.pdf'
  }));
  assert(!reviewPdf.calls.includes('remove:/library/book-1.pdf') &&
    reviewPdfResult.book.sourceRetainedAfterExtract === true,
  'retains a review-needed PDF source after creating its XBook artifact');
  assert(artifactSourceInfo?.sourceDocument?._pdfStructureVersion === 2,
    'passes versioned PDF page data into the XBook artifact');

  const provenPdf = createFixture({
    normalizeBook: async ({ id }) => ({
      finalPath: `/library/${id}.pdf`, filename: `${id}.pdf`, originalFormat: 'PDF',
      originalSize: 12 * 1024, finalSize: 12 * 1024, largeSource: false, resized: false
    }),
    document: { extractChapters: async () => reviewChapters },
    shouldDiscardSourceAfterExtract: () => true,
    createArtifact: async () => ({
      xbookPath: '/library/book-1.xbook.json',
      artifact: { sourceFormat: 'PDF', metadata: {}, chapters: reviewChapters }
    }),
    proveArtifactRecovery: async () => ({ proven: true, reason: 'round-trip-equivalent' })
  });
  const provenPdfResult = await provenPdf.importer.import(command({ originalName: 'book.pdf' }));
  assert(provenPdf.calls.includes('remove:/library/book-1.pdf') && provenPdfResult.book.sourceDeletedAfterExtract,
    'deletes a new raw source only after an equivalent artifact round trip is proven');

  let kindleCoverRecord;
  const manualKindle = createFixture({
    normalizeBook: async ({ id }) => ({
      finalPath: `/library/${id}.azw3`,
      filename: `${id}.azw3`,
      originalFormat: 'AZW3',
      originalSize: 12 * 1024,
      finalSize: 12 * 1024,
      largeSource: false,
      resized: false
    }),
    shouldDiscardSourceAfterExtract: () => true,
    createArtifact: async () => ({
      xbookPath: '/library/book-1.xbook.json',
      artifact: {
        sourceFormat: 'AZW3',
        embeddedCover: true,
        metadata: { title: 'Embedded title', author: 'Embedded author', language: 'en' },
        chapters: [readableChapter()]
      }
    }),
    ensureBookCover: async record => {
      kindleCoverRecord = record;
    }
  });
  const manualKindleResult = await manualKindle.importer.import(command({
    originalName: 'book.azw3'
  }));
  assert(
    manualKindleResult.book.coverSource === 'embedded' &&
      kindleCoverRecord?.coverSource === 'embedded',
    'manual Kindle imports retain exact-edition embedded cover provenance'
  );
  assert(manualKindleResult.book.sourceRetainedAfterExtract === true &&
    !manualKindle.calls.includes('remove:/library/book-1.azw3'),
  'retains a compacted Kindle source when the artifact cannot prove rebuild equivalence');

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

  let coverRecord;
  const groupedIdentity = createFixture({
    metadata: {
      resolveIdentity: async () => {
        throw new Error('trusted selected identity should bypass a second catalog lookup');
      }
    },
    ensureBookCover: async record => {
      coverRecord = record;
    }
  });
  const groupedIdentityResult = await groupedIdentity.importer.import(command({
    kind: 'download',
    selectedIdentity: {
      openLibraryWorkKey: '/works/OL12345W',
      confidence: { score: 0.98, level: 'high' },
      matchedFrom: 'search'
    }
  }));
  assert(groupedIdentityResult.book.openLibraryWorkKey === '/works/OL12345W',
    'persists the trusted grouped-work identity without re-resolving it');
  assert(coverRecord?.openLibraryWorkKey === '/works/OL12345W',
    'uses the trusted grouped-work identity during initial shelf cover selection');

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
      ? { isGoodStructure: true, structureVerified: true, reasons: [], contentChapters: 2, maxChapterSize: 20_000 }
      : { isGoodStructure: false, structureVerified: true, reasons: ['weak structure'], contentChapters: 1, maxChapterSize: 20_000 }
  });
  const alternativeFailureResult = await alternativeFailure.importer.import(command({
    alternatives: [{
      id: 'alternative',
      originalName: 'alternative.epub',
      sourcePath: '/uploads/alternative.epub'
    }]
  }));
  assert(alternativeFailureResult.book.id === 'book-1',
    'retains a verified short primary after an alternative preparation failure');
  assert(alternativeFailure.calls.includes('remove:/library/alternative.epub'),
    'cleans up a normalized alternative when its preparation throws');
  assert(!alternativeFailure.calls.includes('remove:/uploads/alternative.epub'),
    'does not delete an alternative command source path during cleanup');

  const unverifiedStructure = createFixture({
    checkChapterQuality: async () => ({
      isGoodStructure: false,
      structureVerified: false,
      reasons: ['EPUB spine reading order could not be verified'],
      contentChapters: 2,
      maxChapterSize: 20_000
    })
  });
  const unverifiedStructureResult = await unverifiedStructure.importer.import(command());
  assert(unverifiedStructureResult.book.id === 'book-1',
    'accepts a meaningful primary when chapter structure cannot be verified');
  assert(!unverifiedStructure.calls.includes('remove:/library/book-1.epub'),
    'retains the playable source when only structure confidence is unknown');

  const misclassifiedStructure = createFixture({
    checkChapterQuality: async () => ({
      isGoodStructure: false,
      structureVerified: false,
      reasons: ['No content chapters after derived type classification'],
      contentChapters: 0,
      maxChapterSize: 20_000
    })
  });
  const misclassifiedResult = await misclassifiedStructure.importer.import(command());
  assert(misclassifiedResult.book.id === 'book-1',
    'does not turn a derived zero-content-chapter score into an import rejection');

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

  const verifiedShortAlternative = createFixture({
    checkChapterQuality: async source => source.includes('primary')
      ? {
          isGoodStructure: false,
          structureVerified: false,
          reasons: ['EPUB spine reading order could not be verified'],
          contentChapters: 5,
          maxChapterSize: 20_000
        }
      : {
          isGoodStructure: false,
          structureVerified: true,
          reasons: ['Only 1 content chapter'],
          contentChapters: 1,
          maxChapterSize: 20_000
        }
  });
  const verifiedShortResult = await verifiedShortAlternative.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [{
      id: 'verified-short',
      originalName: 'verified-short.epub',
      sourcePath: '/uploads/verified-short.epub'
    }]
  }));
  assert(!verifiedShortResult.usedAlternative && verifiedShortResult.book.id === 'primary',
    'does not discard a larger meaningful primary solely for verified structure');

  const unverifiedLargeAlternative = createFixture({
    checkChapterQuality: async source => source.includes('primary')
      ? {
          isGoodStructure: false,
          structureVerified: true,
          reasons: ['Only 1 content chapter'],
          contentChapters: 1,
          maxChapterSize: 20_000
        }
      : {
          isGoodStructure: false,
          structureVerified: false,
          reasons: ['EPUB spine reading order could not be verified'],
          contentChapters: 5,
          maxChapterSize: 20_000
        }
  });
  const retainedVerifiedShort = await unverifiedLargeAlternative.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [{
      id: 'unverified-large',
      originalName: 'unverified-large.epub',
      sourcePath: '/uploads/unverified-large.epub'
    }]
  }));
  assert(retainedVerifiedShort.usedAlternative && retainedVerifiedShort.book.id === 'unverified-large',
    'prefers a compatible alternative that retains substantially more meaningful text');

  const cleanerAlternative = createFixture({
    checkChapterQuality: async source => source.includes('primary')
      ? {
          isGoodStructure: true,
          structureVerified: true,
          reasons: [],
          contentChapters: 4,
          maxChapterSize: 20_000,
          totalChars: 60_000,
          replacementChars: 196,
          structureKey: 'same-boundaries'
        }
      : {
          isGoodStructure: true,
          structureVerified: true,
          reasons: [],
          contentChapters: 4,
          maxChapterSize: 20_000,
          totalChars: 59_500,
          replacementChars: 0,
          structureKey: 'same-boundaries'
        }
  });
  const cleanerAlternativeResult = await cleanerAlternative.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [{
      id: 'cleaner',
      originalName: 'cleaner.epub',
      sourcePath: '/uploads/cleaner.epub'
    }]
  }));
  assert(cleanerAlternativeResult.usedAlternative && cleanerAlternativeResult.book.id === 'cleaner',
    'prefers an equally complete compatible edition with materially less decode loss');

  const laterCleanerAlternative = createFixture({
    checkChapterQuality: async source => {
      if (source.includes('primary')) {
        return {
          isGoodStructure: true, structureVerified: true, reasons: [], contentChapters: 4,
          maxChapterSize: 20_000, totalChars: 60_000, replacementChars: 196,
          structureKey: 'same-boundaries'
        };
      }
      if (source.includes('noisy-longer')) {
        return {
          isGoodStructure: true, structureVerified: true, reasons: [], contentChapters: 4,
          maxChapterSize: 20_000, totalChars: 60_050, replacementChars: 196,
          structureKey: 'same-boundaries'
        };
      }
      return {
        isGoodStructure: true, structureVerified: true, reasons: [], contentChapters: 4,
        maxChapterSize: 20_000, totalChars: 59_500, replacementChars: 0,
        structureKey: 'same-boundaries'
      };
    }
  });
  const laterCleanerResult = await laterCleanerAlternative.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [
      { id: 'noisy-longer', originalName: 'noisy-longer.epub', sourcePath: '/uploads/noisy-longer.epub' },
      { id: 'cleaner', originalName: 'cleaner.epub', sourcePath: '/uploads/cleaner.epub' }
    ]
  }));
  assert(laterCleanerResult.usedAlternative && laterCleanerResult.book.id === 'cleaner',
    'continues past a slightly longer damaged edition to an equally complete clean edition');

  const differentlyStructuredCleaner = createFixture({
    checkChapterQuality: async source => source.includes('primary')
      ? {
          isGoodStructure: true, structureVerified: true, reasons: [], contentChapters: 4,
          maxChapterSize: 20_000, totalChars: 60_000, replacementChars: 196,
          structureKey: 'primary-boundaries'
        }
      : {
          isGoodStructure: true, structureVerified: true, reasons: [], contentChapters: 4,
          maxChapterSize: 20_000, totalChars: 59_500, replacementChars: 0,
          structureKey: 'different-boundaries'
        }
  });
  const differentlyStructuredResult = await differentlyStructuredCleaner.importer.import(command({
    id: 'primary',
    sourcePath: '/uploads/primary.epub',
    alternatives: [{ id: 'cleaner', originalName: 'cleaner.epub', sourcePath: '/uploads/cleaner.epub' }]
  }));
  assert(!differentlyStructuredResult.usedAlternative && differentlyStructuredResult.book.id === 'primary',
    'does not trade chapter boundaries for cosmetic decode cleanup');

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

  // Spine-granularity file warnings vs extracted-chapter reality
  const { buildImportValidationReport } = require('../lib/import-validation');
  const spineWarning = '38% of chapters are empty or very short. Consider finding a better formatted edition.';
  const goodQuality = { totalChapters: 24, contentChapters: 24, emptyChapters: 0 };
  const suppressed = buildImportValidationReport({
    file: { valid: true, errors: [], warnings: [spineWarning, 'Found 3 consecutive empty/short chapters. Audio playback may have noticeable gaps.'] },
    content: { valid: true, errors: [], warnings: [], quality: goodQuality }
  });
  assert(!suppressed.warnings.some(w => /empty or very short|consecutive empty/.test(w)),
    'healthy extracted chapters suppress spine-granularity short-chapter warnings');
  assert(suppressed.file.warnings.includes(spineWarning),
    'the nested file diagnostics retain the raw spine warning');
  const kept = buildImportValidationReport({
    file: { valid: true, errors: [], warnings: [spineWarning] },
    content: { valid: true, errors: [], warnings: [], quality: { totalChapters: 20, contentChapters: 10, emptyChapters: 10 } }
  });
  assert(kept.warnings.includes(spineWarning),
    'spine warnings survive when extraction confirms many empty chapters');
  const noQuality = buildImportValidationReport({
    file: { valid: true, errors: [], warnings: [spineWarning] }
  });
  assert(noQuality.warnings.includes(spineWarning),
    'spine warnings survive when no extraction quality is available');

  console.log(`\nBook Importer tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
