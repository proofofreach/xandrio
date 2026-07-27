const REFRESH_BOOK_RESULT = Object.freeze({
  REFRESHED: 'refreshed',
  NOT_FOUND: 'not_found'
});

function createBookAudioInvalidator({
  stopPremiumPrep,
  waitForPremiumIdle,
  removePlaybackPrefetch,
  cancelOfflinePreparation,
  waitForOfflineIdle,
  workers,
  removeGenerationJournalEntries,
  invalidateCache
}) {
  return async function invalidateBookAudio(bookId, chapterCount) {
    await Promise.all([
      stopPremiumPrep(bookId),
      removePlaybackPrefetch(bookId),
      cancelOfflinePreparation(bookId)
    ]);
    await waitForOfflineIdle(bookId);

    const affected = Array.from({ length: chapterCount }, (_, chapterIndex) => ({
      bookId,
      chapterIndex,
      fromChunkIndex: 0
    }));
    const activeWorkers = [...new Set(
      typeof workers === 'function' ? workers() : workers
    )];
    await Promise.all(affected.flatMap(item => activeWorkers.map(tts =>
      tts.quiesceChapterAllVariants(
        item.bookId,
        item.chapterIndex,
        {},
        item.fromChunkIndex
      )
    )));
    await waitForPremiumIdle(bookId);
    await removeGenerationJournalEntries(bookId);
    await invalidateCache(affected);
  };
}

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
  invalidateBookAudio = async () => undefined,
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
    let audioError = null;
    const audioAction = reconciliation.audio;
    if (audioAction) {
      try {
        await invalidateBookAudio(bookId, audioAction.chapterCount);
        await clearReconciliationAction(bookId, 'audio', audioAction);
      } catch (error) {
        audioError = error;
      }
    }

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

    if (audioError) throw audioError;
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
    const storageStem = path.basename(book.path, path.extname(book.path));
    const embeddedTitle = String(metadata.title || '').trim().toLowerCase();
    const embeddedTitleMatchesStorageIdentity = Boolean(embeddedTitle) &&
      [bookId, storageStem]
        .map(value => String(value || '').trim().toLowerCase())
        .includes(embeddedTitle);
    const sourceFilename = book.originalFilename || book.uploadedFile || book.filename;
    const sourceFilenameStem = path.basename(
      String(sourceFilename || ''),
      path.extname(String(sourceFilename || ''))
    ).trim().toLowerCase();
    const sourceFilenameMatchesStorageIdentity = Boolean(sourceFilenameStem) &&
      [bookId, storageStem]
        .map(value => String(value || '').trim().toLowerCase())
        .includes(sourceFilenameStem);
    const seedMetadata = embeddedTitleMatchesStorageIdentity
      ? {
          ...metadata,
          title: undefined,
          ...(book.searchedAuthor ? { author: undefined } : {})
        }
      : metadata;
    const fallbackTitle = book.searchedTitle || book.title;
    const fallbackAuthor = book.searchedAuthor || book.author;
    const metadataSeed = resolveMetadataSeed(
      seedMetadata,
      fallbackTitle,
      fallbackAuthor,
      sourceFilenameMatchesStorageIdentity ? undefined : sourceFilename
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

    const epubTitleIsGarbage = embeddedTitleMatchesStorageIdentity ||
      isGarbageTitle(metadata.title) ||
      metadataSeed.embeddedLooksWrong;
    const epubAuthorIsGarbage = isGarbageAuthor(metadata.author);
    const refreshedChapters = await getChaptersCached(book.path);
    const refreshedAuthorCandidate = embeddedTitleMatchesStorageIdentity && book.searchedAuthor
      ? book.searchedAuthor
      : epubAuthorIsGarbage
      ? (enrichedMetadata.author || cleanAuthor || book.author)
      : (metadata.author || enrichedMetadata.author || book.author);
    const refreshedStructureKey = chapterStructureKey(refreshedChapters);
    const refreshedFields = {
      title: epubTitleIsGarbage
        ? (book.searchedTitle || enrichedTitle || cleanTitle || fallbackTitle)
        : (metadata.title || enrichedTitle || fallbackTitle),
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
      const previousChapterCount = Number(current.chapterCount);
      const previousGenerationTotal = Number(current.audioGenerationTotal);
      const structureStateMismatch = (
        Number.isFinite(previousChapterCount) &&
        previousChapterCount !== refreshedChapters.length
      ) || (
        Number.isFinite(previousGenerationTotal) &&
        previousGenerationTotal !== refreshedChapters.length
      );
      const structureNeedsReset = structureChanged || structureStateMismatch;
      const audioChapterCount = Math.max(
        refreshedChapters.length,
        Number.isFinite(previousChapterCount) ? previousChapterCount : 0,
        Number.isFinite(previousGenerationTotal) ? previousGenerationTotal : 0
      );
      const positions = structureChanged
        ? { type: 'remove', structureKey: refreshedStructureKey }
        : (structureIntroduced
            ? { type: 'stamp', structureKey: refreshedStructureKey }
            : currentReconciliation.positions);
      const audio = structureNeedsReset
        ? { chapterCount: audioChapterCount }
        : currentReconciliation.audio;
      const cover = (
        refreshedFields.title !== current.title ||
        refreshedFields.author !== current.author
      )
        ? { cacheKey: `${bookId}_cover.jpg` }
        : currentReconciliation.cover;
      const reconciliation = {
        ...(audio ? { audio } : {}),
        ...(positions ? { positions } : {}),
        ...(cover ? { cover } : {})
      };
      const structureResetFields = structureNeedsReset
        ? {
            totalDuration: refreshedChapters.reduce(
              (sum, chapter) => sum + (chapter.estimatedDuration || 0),
              0
            ),
            chapterDurations: undefined,
            audioGenerationState: undefined,
            audioGeneratedChapters: undefined,
            audioGenerationTotal: undefined,
            audioGenerationUpdatedAt: undefined,
            audioGenerationError: undefined
          }
        : {};
      currentBooks[bookId] = {
        ...current,
        ...refreshedFields,
        ...structureResetFields,
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
  createBookAudioInvalidator,
  createBookMetadataRefreshService
};
