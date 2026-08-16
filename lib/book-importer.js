const pathDefault = require('path');
const { buildSourceProvenance } = require('./source-provenance');
const { chapterStructureKey } = require('./chapter-structure');

class BookImportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BookImportError';
    this.statusCode = options.statusCode || 400;
    this.response = options.response;
    this.existingBookId = options.existingBookId;
    this.details = options.details;
  }
}

function createBookImporter(dependencies) {
  const {
    normalizeBook,
    document,
    checkChapterQuality,
    relaxValidation = async (_bookPath, validation) => validation,
    shouldDiscardSourceAfterExtract,
    createArtifact,
    writeArtifactData,
    assessExtractedContent,
    metadata,
    inferGutenbergId = async () => undefined,
    ensureBookCover = async () => undefined,
    persistBook,
    removeFile = async () => undefined,
    path = pathDefault,
    now = () => new Date().toISOString(),
    log = console,
    maxAlternativeAttempts = 3,
    afterPersist = () => undefined,
    proveArtifactRecovery = async () => ({ proven: false, reason: 'recovery-not-proven' })
  } = dependencies || {};

  if (!normalizeBook || !document || !checkChapterQuality || !shouldDiscardSourceAfterExtract ||
      !assessExtractedContent || !metadata || !persistBook) {
    throw new Error('Book Importer requires document, normalization, validation, metadata, and persistence dependencies');
  }

  function publicFailure(command, type, details) {
    const isUpload = command.kind === 'upload' || command.kind === 'calibre';
    if (type === 'validation') {
      return isUpload
        ? {
          error: 'Book validation failed',
          details: (details.errors || []).join('; '),
          warnings: details.warnings || [],
          suggestion: 'Please check your book file and try again'
        }
        : {
          error: 'Downloaded file is corrupted or invalid',
          details: details.errors || [],
          warnings: details.warnings || [],
          suggestion: command.alternatives?.length
            ? 'No automatic alternative passed validation. Try one of the remaining versions below.'
            : 'Try downloading a different version from the search results.',
          retryAlternatives: (command.alternatives || []).slice(0, 6)
        };
    }
    if (type === 'content') {
      return isUpload
        ? {
          error: 'Book content validation failed',
          details: (details.errors || []).join('; '),
          warnings: details.warnings || [],
          suggestion: 'Please try a better-formatted version.'
        }
        : {
          error: 'Downloaded book content validation failed',
          details: (details.errors || []).join('; '),
          warnings: details.warnings || [],
          suggestion: 'Try a different version from the search results.'
        };
    }
    return {
      error: 'Downloaded book has unusable chapter structure',
      details: details.reasons || [],
      suggestion: 'Try a different version from the search results.'
    };
  }

  function largeSourceWarning(normalized) {
    if (!normalized.largeSource) return [];
    return [
      `Large ${normalized.originalFormat} source (${Math.round(normalized.originalSize / 1024 / 1024)}MB). Stored without external conversion.`
    ];
  }

  function createFileOwnership() {
    const ownedPaths = new Set();

    return {
      add(filePath) {
        if (filePath) ownedPaths.add(filePath);
      },
      release(filePath) {
        ownedPaths.delete(filePath);
      },
      async remove(filePath) {
        if (!ownedPaths.has(filePath)) return;
        await removeFile(filePath);
        ownedPaths.delete(filePath);
      },
      async cleanupPath(filePath) {
        if (!ownedPaths.has(filePath)) return;
        try {
          await removeFile(filePath);
          ownedPaths.delete(filePath);
        } catch (error) {
          log.error(`Import cleanup failed for ${filePath}: ${error.message}`);
        }
      },
      async cleanup() {
        for (const filePath of [...ownedPaths].reverse()) {
          await this.cleanupPath(filePath);
        }
      }
    };
  }

  function retainedTextMeasure(prepared) {
    const measured = Number(prepared?.quality?.totalChars);
    if (Number.isFinite(measured) && measured >= 0) return measured;
    if (Array.isArray(prepared?.extractedChapters)) {
      return prepared.extractedChapters.reduce(
        (sum, chapter) => sum + String(chapter?.text || '').trim().length,
        0
      );
    }
    // Older quality adapters expose only substantial-section counts. Use that
    // as a conservative ordering fallback until they provide retained chars.
    return Math.max(0, Number(prepared?.quality?.contentChapters) || 0) * 1000;
  }

  function improvesStructure(candidate, current) {
    if (candidate?.quality?.isGoodStructure && !current?.quality?.isGoodStructure) return true;
    return candidate?.quality?.structureVerified !== false && current?.quality?.structureVerified === false;
  }

  function preservesStructure(candidate, current) {
    if (current?.quality?.isGoodStructure && !candidate?.quality?.isGoodStructure) return false;
    if (current?.quality?.structureVerified !== false && candidate?.quality?.structureVerified === false) return false;
    const candidateKey = String(candidate?.quality?.structureKey || '');
    const currentKey = String(current?.quality?.structureKey || '');
    return Boolean(candidateKey && currentKey && candidateKey === currentKey);
  }

  function materiallyImprovesDecodeIntegrity(candidate, current) {
    const currentCount = Math.max(0, Number(current?.quality?.replacementChars) || 0);
    const candidateCount = Math.max(0, Number(candidate?.quality?.replacementChars) || 0);
    if (currentCount === 0 || candidateCount >= currentCount) return false;
    return candidateCount === 0 || candidateCount <= currentCount * 0.25;
  }

  function hasDecodeLoss(candidate) {
    return Math.max(0, Number(candidate?.quality?.replacementChars) || 0) > 0;
  }

  async function prepareCandidate(command, candidate, progress, ownership) {
    let sourcePath = candidate.sourcePath;
    if (!sourcePath && candidate.acquire) {
      sourcePath = await candidate.acquire(progress);
    }
    if (!sourcePath) throw new Error('Import candidate did not provide a source path');

    progress(3, 'Checking file format');
    const normalized = await normalizeBook({
      sourcePath,
      originalName: candidate.originalName || command.originalName,
      id: candidate.id || command.id
    });
    ownership.add(normalized.finalPath);
    try {
      const shouldCreateArtifact = shouldDiscardSourceAfterExtract(normalized);
      let extractedChapters = null;
      let preExtractedMetadata = null;
      if (shouldCreateArtifact) {
        [preExtractedMetadata, extractedChapters] = await Promise.all([
          document.extractMetadata(normalized.finalPath),
          document.extractChapters(normalized.finalPath)
        ]);
      }
      let validation = extractedChapters
        ? document.validateExtractedChapters(extractedChapters, {
          format: normalized.originalFormat,
          fileSize: normalized.finalSize
        })
        : await document.validateBook(normalized.finalPath);
      validation = await relaxValidation(normalized.finalPath, validation, {
        hash: candidate.id || command.id,
        gutenbergId: candidate.gutenbergId || command.gutenbergId,
        metadata: preExtractedMetadata
      });
      if (!validation.valid) {
        await ownership.remove(normalized.finalPath);
        return {
          valid: false,
          candidate,
          normalized,
          validation,
          quality: {
            isGoodStructure: false,
            structureVerified: false,
            reasons: validation.errors || [],
            contentChapters: 0,
            maxChapterSize: Infinity
          }
        };
      }
      validation.warnings.push(...largeSourceWarning(normalized));
      const quality = await checkChapterQuality(normalized.finalPath);
      return {
        valid: true,
        candidate,
        normalized,
        validation,
        quality,
        shouldCreateArtifact,
        preExtractedMetadata,
        extractedChapters
      };
    } catch (error) {
      await ownership.cleanupPath(normalized.finalPath);
      throw error;
    }
  }

  async function chooseCandidate(command, progress, ownership) {
    const primary = {
      id: command.id,
      originalName: command.originalName,
      sourcePath: command.sourcePath,
      acquire: command.acquire,
      selected: command.selected,
      source: command.downloadSource,
      sourceFilePath: command.sourceFilePath,
      sourceProvenance: command.sourceProvenance,
      gutenbergId: command.gutenbergId
    };
    let best = await prepareCandidate(command, primary, progress, ownership);
    const initialValidationFailed = !best.valid;
    const alternatives = Array.isArray(command.alternatives) ? command.alternatives : [];
    if ((!initialValidationFailed && best.quality.isGoodStructure && !hasDecodeLoss(best)) || alternatives.length === 0) {
      return { selected: best, usedAlternative: false, initialValidationFailed };
    }

    const selectedIdentity = command.selectedIdentity || await metadata.resolveIdentity({
      title: command.selected?.title,
      author: command.selected?.author,
      language: command.selected?.language
    });
    const compatibleAlternatives = [];
    for (const alternative of alternatives) {
      if (!alternative?.id) continue;
      if (alternative.shouldTry && !(await alternative.shouldTry(selectedIdentity))) continue;
      compatibleAlternatives.push(alternative);
    }
    let usedAlternative = false;
    const maxAttempts = Math.min(compatibleAlternatives.length, maxAlternativeAttempts);
    for (let index = 0; index < maxAttempts; index++) {
      const alternative = compatibleAlternatives[index];
      progress(5, `Trying alternative version ${index + 1} of ${maxAttempts}`);
      try {
        const prepared = await prepareCandidate(command, alternative, progress, ownership);
        if (!prepared.valid) continue;
        const preparedText = retainedTextMeasure(prepared);
        const bestText = retainedTextMeasure(best);
        const gainsText = preparedText > bestText;
        const conservesText = preparedText >= bestText;
        const conservesNearlyAllText = bestText > 0 && preparedText >= bestText * 0.99;
        const fixesDecodeLoss = conservesNearlyAllText &&
          preservesStructure(prepared, best) &&
          materiallyImprovesDecodeIntegrity(prepared, best);
        const replacesBest = !best.valid || gainsText ||
          (conservesText && improvesStructure(prepared, best)) || fixesDecodeLoss;
        if (!replacesBest) {
          await ownership.remove(prepared.normalized.finalPath);
          continue;
        }
        if (best.valid) await ownership.remove(best.normalized.finalPath);
        best = prepared;
        usedAlternative = true;
        if (prepared.quality.isGoodStructure && !hasDecodeLoss(prepared)) break;
      } catch (error) {
        log.log(`Alternative version ${index + 1} failed: ${error.message}`);
      }
    }
    return { selected: best, usedAlternative, initialValidationFailed };
  }

  async function materializeArtifact(prepared, command, ownership) {
    const { normalized, candidate } = prepared;
    let finalPath = normalized.finalPath;
    let filename = normalized.filename;
    let metadataValue = prepared.preExtractedMetadata || await document.extractMetadata(finalPath);
    let extractedChapters = prepared.extractedChapters;
    let extractedArtifactPath;
    let extractedArtifact;
    let sourceDeletedAfterExtract = false;
    let sourceRetainedAfterExtract = false;
    let retainedSourcePath;

    if (!prepared.shouldCreateArtifact) {
      return {
        finalPath,
        filename,
        metadata: metadataValue,
        extractedChapters,
        extractedArtifactPath,
        extractedArtifact,
        sourceDeletedAfterExtract,
        sourceRetainedAfterExtract,
        retainedSourcePath
      };
    }
    if (!createArtifact) throw new Error('Book Importer requires createArtifact for compact-source imports');
    const artifactResult = await createArtifact(candidate.id || command.id, finalPath, {
      originalFormat: normalized.originalFormat,
      originalFilename: candidate.originalName || command.originalName,
      originalSize: normalized.originalSize,
      metadata: metadataValue,
      chapters: extractedChapters,
      sourceDocument: extractedChapters?.sourceDocument
    });
    extractedArtifactPath = artifactResult.xbookPath;
    extractedArtifact = artifactResult.artifact;
    ownership.add(extractedArtifactPath);
    const artifactValidation = await document.validateBook(extractedArtifactPath);
    if (!artifactValidation.valid) {
      throw new Error(`Extracted book artifact failed validation: ${artifactValidation.errors.join('; ')}`);
    }
    let recoveryProof;
    try {
      recoveryProof = await proveArtifactRecovery({
        sourceFormat: normalized.originalFormat,
        acceptedChapters: extractedChapters || [],
        sourceDocument: extractedArtifact.sourceDocument,
        artifact: extractedArtifact
      });
    } catch (error) {
      recoveryProof = { proven: false, reason: `recovery-proof-failed:${error.code || error.name || 'error'}` };
    }
    extractedArtifact.recoveryProof = {
      proven: recoveryProof?.proven === true,
      reason: recoveryProof?.reason || undefined,
      checkedAt: now()
    };
    if (!recoveryProof?.proven) {
      sourceRetainedAfterExtract = true;
      retainedSourcePath = finalPath;
      extractedArtifact.sourceDeleted = false;
      extractedArtifact.sourcePath = finalPath;
      prepared.validation.warnings.push(
        `Retained original ${normalized.originalFormat} because artifact recovery was not proven`
      );
    } else {
      if (!writeArtifactData) {
        sourceRetainedAfterExtract = true;
        retainedSourcePath = finalPath;
        extractedArtifact.sourceDeleted = false;
        extractedArtifact.sourcePath = finalPath;
        extractedArtifact.sourceDeletion = { state: 'not-started', reason: 'durable-writer-unavailable' };
      } else {
        // The retained recovery artifact and deletion intent are durable before
        // the original becomes deletable. After this point cleanup must never
        // remove the only recoverable representation.
        extractedArtifact.sourceDeleted = false;
        extractedArtifact.sourcePath = finalPath;
        extractedArtifact.sourceDeletion = { state: 'intent', preparedAt: now() };
        await writeArtifactData(extractedArtifactPath, extractedArtifact);
        ownership.release(extractedArtifactPath);
        ownership.release(finalPath);
        try {
          await removeFile(finalPath);
        } catch (error) {
          sourceRetainedAfterExtract = true;
          retainedSourcePath = finalPath;
          extractedArtifact.sourceDeletion = {
            state: 'retained',
            reason: `delete-failed:${error.code || error.name || 'error'}`
          };
          await writeArtifactData(extractedArtifactPath, extractedArtifact);
          finalPath = extractedArtifactPath;
          filename = path.basename(extractedArtifactPath);
          return {
            finalPath,
            filename,
            metadata: extractedArtifact.metadata || metadataValue,
            extractedChapters,
            extractedArtifactPath,
            extractedArtifact,
            sourceDeletedAfterExtract,
            sourceRetainedAfterExtract,
            retainedSourcePath,
            recoveryProof: extractedArtifact.recoveryProof
          };
        }
      }
      if (!sourceRetainedAfterExtract) {
        delete extractedArtifact.sourcePath;
        extractedArtifact.sourceDeletion = { state: 'completed', completedAt: now() };
        extractedArtifact.sourceDeleted = true;
        sourceDeletedAfterExtract = true;
      }
      prepared.validation.warnings.push(sourceDeletedAfterExtract
        ? `Stored recoverable XBook artifact and deleted original ${normalized.originalFormat} source after a successful round-trip proof`
        : `Retained original ${normalized.originalFormat} because a durable deletion intent could not be recorded`);
    }
    if (writeArtifactData) await writeArtifactData(extractedArtifactPath, extractedArtifact);
    finalPath = extractedArtifactPath;
    filename = path.basename(extractedArtifactPath);
    metadataValue = extractedArtifact.metadata || metadataValue;
    return {
      finalPath,
      filename,
      metadata: metadataValue,
      extractedChapters,
      extractedArtifactPath,
      extractedArtifact,
      sourceDeletedAfterExtract,
      sourceRetainedAfterExtract,
      retainedSourcePath,
      recoveryProof: extractedArtifact.recoveryProof
    };
  }

  async function importBook(command, progress = () => {}) {
    if (!command?.id || !command?.originalName || (!command.sourcePath && !command.acquire)) {
      throw new Error('Book import command requires id, originalName, and a source path or acquisition callback');
    }
    const ownership = createFileOwnership();
    let persistenceCommitted = false;

    try {
      const { selected: prepared, usedAlternative, initialValidationFailed } = await chooseCandidate(command, progress, ownership);
      if (!prepared.valid) {
        throw new BookImportError('Book validation failed', {
          response: publicFailure(command, 'validation', prepared.validation)
        });
      }
      if (initialValidationFailed && !usedAlternative) {
        throw new BookImportError('Book validation failed', {
          response: publicFailure(command, 'validation', prepared.validation)
        });
      }
      progress(4, 'Reading book metadata');
    const artifact = await materializeArtifact(prepared, command, ownership);
    const selected = prepared.candidate.selected || command.selected || {};
    const catalog = command.catalogMetadata || {};
    const catalogHas = key => Object.prototype.hasOwnProperty.call(catalog, key);
    const metadataSeed = metadata.resolveSeed(
      artifact.metadata,
      selected.title || null,
      selected.author || null,
      prepared.candidate.originalName || command.originalName
    );
    const cleanTitle = metadataSeed.title;
    const cleanAuthor = metadataSeed.author;
    const enriched = await metadata.enrich(cleanTitle, cleanAuthor);
    const enrichedTitle = metadata.trustedTitle(enriched.title, cleanTitle, metadataSeed);
    const openLibraryIdentity = command.selectedIdentity?.openLibraryWorkKey
      ? command.selectedIdentity
      : await metadata.resolveIdentity({
        title: cleanTitle,
        author: cleanAuthor,
        language: selected.language || artifact.metadata.language,
        isbn: artifact.metadata.isbn
      });
    const chapters = artifact.extractedChapters || await document.extractChapters(artifact.finalPath);
    const contentValidation = assessExtractedContent(chapters, { format: prepared.normalized.originalFormat });
    if (!contentValidation.valid) {
      throw new BookImportError('Book content validation failed', {
        response: publicFailure(command, 'content', contentValidation)
      });
    }
    const metadataValidation = metadata.assessConfidence({
      selectedTitle: selected.title,
      selectedAuthor: selected.author,
      embeddedTitle: artifact.metadata.title,
      embeddedAuthor: artifact.metadata.author,
      filenameTitle: metadataSeed.filenameMetadata?.title,
      enrichedTitle,
      enrichedAuthor: enriched.author,
      openLibrary: openLibraryIdentity
    });
    const importValidation = metadata.buildValidation({
      file: prepared.validation,
      content: contentValidation,
      metadata: metadataValidation,
      needsReview: usedAlternative,
      source: {
        selectedHash: prepared.candidate.id || command.id,
        sourceFormat: prepared.normalized.originalFormat,
        usedAlternative: command.kind === 'download' ? usedAlternative : undefined,
        uploadedFile: (command.kind === 'upload' || command.kind === 'calibre') ? command.originalName : undefined
      }
    });
    if (artifact.extractedArtifact && writeArtifactData) {
      artifact.extractedArtifact.importValidation = importValidation;
      artifact.extractedArtifact.processingVersion = contentValidation.extractionResult?.processingVersion;
      artifact.extractedArtifact.diagnosticCodes = (contentValidation.diagnostics || []).map(item => item.code);
      artifact.extractedArtifact.textIntegrity = contentValidation.extractionResult?.textIntegrity;
      await writeArtifactData(artifact.extractedArtifactPath, artifact.extractedArtifact);
    }

    const titleIsGarbage = metadata.isGarbageTitle(artifact.metadata.title) || metadataSeed.embeddedLooksWrong;
    const authorIsGarbage = metadata.isGarbageAuthor(artifact.metadata.author);
    const fallbackTitle = command.kind === 'upload' || command.kind === 'calibre'
      ? command.originalName.replace(/\.[^.]+$/i, '')
      : selected.title || command.originalName;
    const resolvedTitle = catalog.title || (titleIsGarbage
      ? (enrichedTitle || cleanTitle || fallbackTitle)
      : (artifact.metadata.title || enrichedTitle || cleanTitle || fallbackTitle));
    const resolvedAuthorCandidate = catalog.author || (authorIsGarbage
      ? (enriched.author || cleanAuthor || selected.author || 'Unknown')
      : (artifact.metadata.author || enriched.author || cleanAuthor || 'Unknown'));
    const resolvedAuthor = metadata.normalizeAuthor
      ? metadata.normalizeAuthor(resolvedAuthorCandidate)
      : resolvedAuthorCandidate;
    const bookId = prepared.candidate.id || command.id;
    const gutenbergId = await inferGutenbergId(artifact.finalPath, {
      hash: bookId,
      gutenbergId: prepared.candidate.gutenbergId || command.gutenbergId,
      metadata: artifact.metadata
    });
    const acquiredAt = now();
    const downloadSource = prepared.candidate.source || command.downloadSource || (command.kind === 'upload' ? 'upload' : 'annas');
    const record = {
      id: bookId,
      title: resolvedTitle,
      author: resolvedAuthor,
      publisher: catalogHas('publisher') ? (catalog.publisher || undefined) : (artifact.metadata.publisher || enriched.publisher),
      publishedDate: catalogHas('publishedDate')
        ? (catalog.publishedDate ? metadata.publishedYear(catalog.publishedDate) : undefined)
        : metadata.publishedYear(artifact.metadata.date, enriched.publishedDate),
      description: metadata.cleanDescription(catalogHas('description')
        ? catalog.description
        : (artifact.metadata.description || enriched.description || command.description)),
      subjects: catalogHas('tags') ? catalog.tags : (enriched.subjects || []),
      language: (catalogHas('language') ? catalog.language : null) || ((command.kind === 'download' && selected.language && selected.language !== 'all')
        ? selected.language
        : (artifact.metadata.language || 'en')),
      isbn: catalogHas('isbn') ? (catalog.isbn || undefined) : (artifact.metadata.isbn || undefined),
      series: catalogHas('series') ? (catalog.series || undefined) : undefined,
      seriesIndex: catalogHas('seriesIndex') ? (catalog.seriesIndex ?? undefined) : undefined,
      calibre: command.calibre || undefined,
      filename: artifact.filename,
      path: artifact.finalPath,
      ...((command.kind === 'upload' || command.kind === 'calibre') ? { uploadedFile: command.originalName } : {
        searchedTitle: selected.title || undefined,
        searchedAuthor: selected.author || undefined,
        sourceFilePath: prepared.candidate.sourceFilePath || command.sourceFilePath || undefined
      }),
      sourceFormat: prepared.normalized.originalFormat === 'EPUB' ? undefined : prepared.normalized.originalFormat,
      pdfExtraction: contentValidation.stats?.pdfExtraction || undefined,
      canRebuildChapters: Boolean(chapters?.sourceDocument?.pages?.length) || undefined,
      processingVersion: contentValidation.extractionResult?.processingVersion,
      importDiagnosticCodes: (contentValidation.diagnostics || []).map(item => item.code),
      textIntegrity: contentValidation.extractionResult?.textIntegrity,
      sourceDeletedAfterExtract: artifact.sourceDeletedAfterExtract || undefined,
      sourceRetainedAfterExtract: artifact.sourceRetainedAfterExtract || undefined,
      sourcePath: artifact.retainedSourcePath || undefined,
      retainedSourcePath: artifact.retainedSourcePath || undefined,
      sourceRecovery: artifact.recoveryProof || undefined,
      extractedArtifact: artifact.extractedArtifactPath || undefined,
      originalFilename: artifact.extractedArtifactPath ? (prepared.candidate.originalName || command.originalName) : undefined,
      wasResized: prepared.normalized.resized || undefined,
      addedAt: acquiredAt,
      addedBy: command.addedBy || undefined,
      sourceHash: bookId,
      downloadSource,
      sourceProvenance: buildSourceProvenance({
        provider: downloadSource,
        acquiredAt,
        originalFilename: (command.kind === 'upload' || command.kind === 'calibre') ? command.originalName : undefined,
        details: prepared.candidate.sourceProvenance || command.sourceProvenance
      }),
      ...((command.kind === 'upload' || command.kind === 'calibre') && artifact.extractedArtifact?.embeddedCover
        ? { coverSource: 'embedded' }
        : {}),
      gutenbergId: gutenbergId || undefined,
      chapterCount: chapters.length,
      chapterStructureKey: chapterStructureKey(chapters) || undefined,
      ...metadata.openLibraryFields(openLibraryIdentity)
    };
    record.workKey = metadata.canonicalWorkKey(record.title, record.author) || undefined;
    record.importValidation = importValidation;

    progress(6, 'Finding cover');
    await ensureBookCover(record).catch(error => log.error(`Import cover fetch failed: ${error.message}`));
    progress(7, 'Adding to library');
    const persistence = await persistBook(record);
    if (persistence?.existingBook) {
      const existingBook = persistence.existingBook;
      throw new BookImportError('Book already exists in library', {
        existingBookId: existingBook.id,
        details: `"${existingBook.title}" by ${existingBook.author} is already in your library`
      });
    }
    persistenceCommitted = true;
    await afterPersist(record, artifact.finalPath);
    return {
      bookId,
      book: record,
      // The aggregated report is the authority on surfaced warnings: it
      // reconciles file-level spine heuristics with extracted-chapter
      // quality, while prepared.validation still carries the raw file list.
      validation: { valid: true },
      usedAlternative: usedAlternative || false
    };
    } catch (error) {
      if (!persistenceCommitted) await ownership.cleanup();
      throw error;
    }
  }

  return { import: importBook };
}

module.exports = { BookImportError, createBookImporter };
