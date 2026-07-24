const REFRESH_BOOK_RESULT = Object.freeze({
  REFRESHED: 'refreshed',
  NOT_FOUND: 'not_found'
});

function createBookMetadataRefreshService({
  booksFile,
  positionsFile,
  cacheDir,
  path,
  loadJSON,
  updateJSON,
  skipSave,
  isXBookPath,
  invalidateXBookArtifactCache,
  extractBookMetadata,
  getChaptersCached,
  resolveMetadataSeed,
  enrichBookMetadata,
  trustedEnrichedTitle,
  resolveOpenLibraryIdentity,
  isGarbageTitle,
  isGarbageAuthor,
  normalizeAuthorForDisplay,
  publishedYearFromMetadata,
  cleanBookDescription,
  chapterStructureKey,
  bookRecordOpenLibraryFields,
  canonicalWorkKey,
  removeFileIfExists,
  removeBookPositions,
  setBookPositionsStructureKey,
  now = () => new Date(),
  log = console
}) {
  const reconciliationField = 'metadataRefreshReconciliation';

  function sameAction(current, expected) {
    return JSON.stringify(current) === JSON.stringify(expected);
  }

  async function clearReconciliationAction(bookId, actionName, completedAction) {
    await updateJSON(booksFile, (books) => {
      const current = books[bookId];
      const reconciliation = current?.[reconciliationField];
      if (!current || !sameAction(reconciliation?.[actionName], completedAction)) {
        return skipSave;
      }

      const remaining = { ...reconciliation };
      delete remaining[actionName];
      if (Object.keys(remaining).length === 0) {
        delete current[reconciliationField];
      } else {
        current[reconciliationField] = remaining;
      }
      return current;
    });
  }

  async function reconcile(bookId, reconciliation = {}) {
    let positionError = null;
    const positionAction = reconciliation.positions;
    if (positionAction) {
      try {
        if (positionAction.type === 'remove') {
          await updateJSON(positionsFile, positions => removeBookPositions(positions, bookId));
        } else if (positionAction.type === 'stamp') {
          await updateJSON(positionsFile, positions =>
            setBookPositionsStructureKey(positions, bookId, positionAction.structureKey));
        }
        await clearReconciliationAction(bookId, 'positions', positionAction);
      } catch (error) {
        positionError = error;
      }
    }

    const coverAction = reconciliation.cover;
    if (coverAction) {
      try {
        await removeFileIfExists(path.join(cacheDir, `${bookId}_cover.jpg`));
        await clearReconciliationAction(bookId, 'cover', coverAction);
      } catch (error) {
        // Cover eviction is a derived-cache repair. Keep its marker for a
        // future refresh, but never let it prevent position reconciliation.
        log.warn(`Metadata refresh could not evict the cached cover for ${bookId}: ${error.message}`);
      }
    }

    if (positionError) throw positionError;
  }

  async function refreshBook(bookId) {
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) return { status: REFRESH_BOOK_RESULT.NOT_FOUND };

    if (isXBookPath(book.path)) {
      invalidateXBookArtifactCache(book.path);
    }
    const metadata = await extractBookMetadata(book.path);
    const metadataSeed = resolveMetadataSeed(
      metadata,
      book.title,
      book.author,
      book.originalFilename || book.uploadedFile || book.filename
    );
    const cleanTitle = metadataSeed.title;
    const cleanAuthor = metadataSeed.author;
    const enrichedMetadata = await enrichBookMetadata(cleanTitle, cleanAuthor);
    const enrichedTitle = trustedEnrichedTitle(enrichedMetadata.title, cleanTitle, metadataSeed);
    const openLibraryIdentity = await resolveOpenLibraryIdentity({
      title: cleanTitle,
      author: cleanAuthor,
      language: metadata.language || book.language,
      isbn: metadata.isbn
    }, { timeoutMs: 5000 });

    const epubTitleIsGarbage = isGarbageTitle(metadata.title) || metadataSeed.embeddedLooksWrong;
    const epubAuthorIsGarbage = isGarbageAuthor(metadata.author);
    const refreshedChapters = await getChaptersCached(book.path);
    const refreshedAuthorCandidate = epubAuthorIsGarbage
      ? (enrichedMetadata.author || cleanAuthor || book.author)
      : (metadata.author || enrichedMetadata.author || book.author);
    const refreshedStructureKey = chapterStructureKey(refreshedChapters);
    const refreshedFields = {
      title: epubTitleIsGarbage
        ? (enrichedTitle || cleanTitle || book.title)
        : (metadata.title || enrichedTitle || book.title),
      author: normalizeAuthorForDisplay(refreshedAuthorCandidate),
      publisher: metadata.publisher || enrichedMetadata.publisher,
      publishedDate: publishedYearFromMetadata(metadata.date, enrichedMetadata.publishedDate),
      description: cleanBookDescription(metadata.description || enrichedMetadata.description),
      subjects: enrichedMetadata.subjects || [],
      language: metadata.language || book.language || 'en',
      chapterCount: refreshedChapters.length,
      chapter1Ready: false,
      preloadedThrough: null,
      ...bookRecordOpenLibraryFields(openLibraryIdentity),
      metadataRefreshed: now().toISOString()
    };
    refreshedFields.workKey = canonicalWorkKey(refreshedFields.title, refreshedFields.author) || book.workKey;

    const updatedBook = await updateJSON(booksFile, (currentBooks) => {
      const current = currentBooks[bookId];
      if (!current) return skipSave;
      const currentReconciliation = current[reconciliationField] || {};
      const structureIntroduced = Boolean(refreshedStructureKey) && !current.chapterStructureKey;
      const structureChanged = Boolean(refreshedStructureKey && current.chapterStructureKey) &&
        refreshedStructureKey !== current.chapterStructureKey;
      const positions = structureChanged
        ? { type: 'remove', structureKey: refreshedStructureKey }
        : (structureIntroduced
            ? { type: 'stamp', structureKey: refreshedStructureKey }
            : currentReconciliation.positions);
      const cover = (
        refreshedFields.title !== current.title ||
        refreshedFields.author !== current.author
      )
        ? { cacheKey: `${bookId}_cover.jpg` }
        : currentReconciliation.cover;
      const reconciliation = {
        ...(positions ? { positions } : {}),
        ...(cover ? { cover } : {})
      };
      currentBooks[bookId] = {
        ...current,
        ...refreshedFields,
        chapterStructureKey: refreshedStructureKey || current.chapterStructureKey,
        ...(Object.keys(reconciliation).length > 0
          ? { [reconciliationField]: reconciliation }
          : {})
      };
      return currentBooks[bookId];
    });
    if (updatedBook === skipSave) return { status: REFRESH_BOOK_RESULT.NOT_FOUND };

    await reconcile(bookId, updatedBook[reconciliationField]);

    const publicBook = { ...updatedBook };
    delete publicBook[reconciliationField];
    return {
      status: REFRESH_BOOK_RESULT.REFRESHED,
      book: publicBook,
      providerWarnings: openLibraryIdentity?.warnings || []
    };
  }

  return { refreshBook };
}

module.exports = {
  REFRESH_BOOK_RESULT,
  createBookMetadataRefreshService
};
