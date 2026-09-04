const { sanitizeCalibreMetadata, stableCalibreBookId } = require('../calibre-integration');
const { badRequest, notFound, unauthorized, conflict, storageError } = require('../http-error');

function bearerToken(req) {
  const header = req.headers?.authorization || '';
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

function calibreIdentities(book) {
  if (Array.isArray(book?.calibre?.identities)) return book.calibre.identities;
  if (book?.calibre?.libraryUuid && book?.calibre?.bookUuid) {
    return [{
      libraryUuid: book.calibre.libraryUuid,
      bookUuid: book.calibre.bookUuid,
      calibreId: book.calibre.calibreId,
      lastModified: book.calibre.lastModified,
      profileIds: Array.isArray(book.calibre.profileIds) ? book.calibre.profileIds : []
    }];
  }
  return [];
}

function mergeCalibreMetadata(book, metadata, options = {}) {
  const { userId, normalizeDescription = value => value, normalizePublishedDate = value => value } = options;
  const next = { ...book };
  for (const key of ['title', 'author']) {
    if (metadata[key]) next[key] = metadata[key];
  }
  const optionalFields = {
    publisher: metadata.publisher,
    publishedDate: metadata.publishedDate == null ? metadata.publishedDate : normalizePublishedDate(metadata.publishedDate),
    description: metadata.description == null ? metadata.description : normalizeDescription(metadata.description),
    language: metadata.language,
    isbn: metadata.isbn,
    series: metadata.series,
    seriesIndex: metadata.seriesIndex
  };
  for (const [key, value] of Object.entries(optionalFields)) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue;
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, 'tags')) next.subjects = metadata.tags;
  const identities = calibreIdentities(book).map(identity => ({ ...identity }));
  const identityIndex = identities.findIndex(identity =>
    identity.libraryUuid === metadata.libraryUuid && identity.bookUuid === metadata.bookUuid);
  const previousIdentity = identityIndex >= 0 ? identities[identityIndex] : {};
  const identity = {
    libraryUuid: metadata.libraryUuid,
    bookUuid: metadata.bookUuid,
    calibreId: metadata.calibreId,
    lastModified: metadata.lastModified,
    profileIds: [...new Set([
      ...(Array.isArray(previousIdentity.profileIds) ? previousIdentity.profileIds : []),
      ...(userId ? [userId] : [])
    ])]
  };
  if (identityIndex >= 0) identities[identityIndex] = identity;
  else identities.push(identity);
  next.calibre = {
    ...identity,
    identities
  };
  return next;
}

function parseMetadataField(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Calibre metadata is required');
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('Calibre metadata must be valid JSON');
  }
  return sanitizeCalibreMetadata(parsed);
}

function registerCalibreRoutes(app, dependencies) {
  const {
    access,
    uploadBook,
    userIdFromRequest,
    loadBooks,
    updateBooks,
    importBook,
    withBookMutationLock = (_bookId, task) => task(),
    persistCover = async () => undefined,
    addBookToShelf = async () => undefined,
    removeFile = async () => undefined,
    publicBookRecord = book => book,
    supportedFormats = [],
    normalizeDescription = value => value,
    normalizePublishedDate = value => value
  } = dependencies;

  async function requireCalibreAccess(req, res, next) {
    try {
      const connection = await access.resolveToken(bearerToken(req));
      if (!connection) return unauthorized(res, 'Calibre connection is invalid or revoked');
      req.calibreConnection = connection;
      return next();
    } catch (error) {
      next(error);
    }
  }

  async function saveOptionalCover(bookId, req) {
    if (!req.calibreCover?.path) return 'not-sent';
    try {
      return await persistCover(bookId, req.calibreCover.path) ? 'imported' : 'rejected';
    } catch (error) {
      await removeFile(req.calibreCover.path).catch(() => undefined);
      console.warn('Calibre cover import failed:', error.message);
      return 'failed';
    }
  }

  app.post('/api/integrations/calibre/pairing-code', async (req, res) => {
    try {
      const pairing = await access.issuePairingCode({ userId: userIdFromRequest(req) });
      res.json(pairing);
    } catch (error) {
      return storageError(res, error, 'Could not create a Calibre pairing code', 'Calibre pairing failed:');
    }
  });

  app.post('/api/integrations/calibre/claim', async (req, res) => {
    try {
      const claimed = await access.claimPairingCode(req.body?.code, {
        clientName: req.body?.clientName
      });
      if (!claimed) return badRequest(res, 'Pairing code is invalid or expired');
      res.json(claimed);
    } catch (error) {
      if (/Too many Calibre connections/.test(error.message)) {
        return conflict(res, error.message);
      }
      return storageError(res, error, 'Could not connect Calibre', 'Calibre pairing claim failed:');
    }
  });

  app.get('/api/integrations/calibre/status', requireCalibreAccess, (req, res) => {
    res.json({
      connected: true,
      connection: req.calibreConnection,
      supportedFormats
    });
  });

  app.get('/api/integrations/calibre/connections', async (req, res) => {
    try {
      res.json({ connections: await access.listConnections(userIdFromRequest(req)) });
    } catch (error) {
      return storageError(res, error, 'Could not load Calibre connections', 'Calibre connection listing failed:');
    }
  });

  app.delete('/api/integrations/calibre/connections/:id', async (req, res) => {
    try {
      const revoked = await access.revokeConnection(userIdFromRequest(req), req.params.id);
      if (!revoked) return notFound(res, 'Calibre connection not found');
      res.json({ success: true });
    } catch (error) {
      return storageError(res, error, 'Could not revoke Calibre connection', 'Calibre connection revocation failed:');
    }
  });

  app.get('/api/integrations/calibre/inventory', requireCalibreAccess, async (req, res) => {
    try {
      const books = await loadBooks();
      const inventory = Object.values(books || {})
        .flatMap(book => calibreIdentities(book)
          .filter(identity => identity.profileIds?.includes(req.calibreConnection.userId))
          .map(identity => ({
            bookId: book.id,
            libraryUuid: identity.libraryUuid,
            bookUuid: identity.bookUuid,
            calibreId: identity.calibreId,
            lastModified: identity.lastModified
          })));
      res.json({ books: inventory });
    } catch (error) {
      return storageError(res, error, 'Could not load the Calibre inventory', 'Calibre inventory failed:');
    }
  });

  app.post('/api/integrations/calibre/import', requireCalibreAccess, uploadBook, async (req, res) => {
    if (!req.file) {
      if (req.calibreCover?.path) await removeFile(req.calibreCover.path).catch(() => undefined);
      return badRequest(res, 'No book file uploaded');
    }
    try {
      const metadata = parseMetadataField(req.body?.metadata);
      const bookId = stableCalibreBookId(metadata.libraryUuid, metadata.bookUuid);
      return await withBookMutationLock(bookId, async () => {
        const books = await loadBooks();
        if (books?.[bookId]) {
          // bookId is sha256 over client-supplied libraryUuid/bookUuid, so a
          // caller who learns another user's pair can address their record.
          // A connection may only update a book it already owns; anything else
          // is refused rather than merged.
          const owner = books[bookId].addedBy;
          if (owner && owner !== req.calibreConnection.userId) {
            await removeFile(req.file.path).catch(() => undefined);
            if (req.calibreCover?.path) await removeFile(req.calibreCover.path).catch(() => undefined);
            return conflict(res, 'This book belongs to another account');
          }
          let updated;
          let wasCurrent = false;
          await updateBooks(current => {
            if (!current[bookId]) return;
            updated = mergeCalibreMetadata(current[bookId], metadata, {
              userId: req.calibreConnection.userId,
              normalizeDescription,
              normalizePublishedDate
            });
            wasCurrent = JSON.stringify(current[bookId]) === JSON.stringify(updated);
            current[bookId] = updated;
          });
          await removeFile(req.file.path);
          await addBookToShelf(req.calibreConnection.userId, bookId);
          const coverStatus = await saveOptionalCover(bookId, req);
          return res.json({
            success: true,
            status: wasCurrent ? 'already-present' : 'updated',
            coverStatus,
            bookId,
            book: publicBookRecord(updated || books[bookId])
          });
        }

        const result = await importBook({
          kind: 'calibre',
          id: bookId,
          originalName: req.file.originalname,
          sourcePath: req.file.path,
          selected: {
            title: metadata.title,
            author: metadata.author,
            language: metadata.language || 'en'
          },
          catalogMetadata: metadata,
          calibre: {
            libraryUuid: metadata.libraryUuid,
            bookUuid: metadata.bookUuid,
            calibreId: metadata.calibreId,
            lastModified: metadata.lastModified,
            profileIds: [req.calibreConnection.userId],
            identities: [{
              libraryUuid: metadata.libraryUuid,
              bookUuid: metadata.bookUuid,
              calibreId: metadata.calibreId,
              lastModified: metadata.lastModified,
              profileIds: [req.calibreConnection.userId]
            }]
          },
          downloadSource: 'calibre',
          sourceProvenance: { itemId: `${metadata.libraryUuid}:${metadata.bookUuid}` },
          addedBy: req.calibreConnection.userId
        });
        await addBookToShelf(req.calibreConnection.userId, result.bookId);
        const coverStatus = await saveOptionalCover(result.bookId, req);
        res.json({
          success: true,
          status: 'imported',
          coverStatus,
          bookId: result.bookId,
          book: publicBookRecord(result.book),
          validation: result.validation
        });
      });
    } catch (error) {
      await removeFile(req.file.path).catch(() => undefined);
      if (error instanceof TypeError) {
        if (req.calibreCover?.path) await removeFile(req.calibreCover.path).catch(() => undefined);
        return badRequest(res, error.message);
      }
      if (error?.existingBookId) {
        let linked;
        let notOwned = false;
        await withBookMutationLock(error.existingBookId, async () => {
          // This branch is reached when the importer matched an *existing*
          // book by fuzzy title/author (workKey), not by an id the caller
          // supplied -- so the target is chosen by the uploaded metadata and
          // can be any book in the library. The direct-id branch above already
          // refuses to write another account's record; the same rule has to
          // apply here, or a crafted title is enough to rewrite a stranger's
          // metadata and overwrite their cover.
          const current = await loadBooks();
          const owner = current?.[error.existingBookId]?.addedBy;
          if (owner && owner !== req.calibreConnection.userId) {
            notOwned = true;
            return;
          }
          await updateBooks(current => {
            if (!current[error.existingBookId]) return;
            linked = mergeCalibreMetadata(current[error.existingBookId], parseMetadataField(req.body?.metadata), {
              userId: req.calibreConnection.userId,
              normalizeDescription,
              normalizePublishedDate
            });
            current[error.existingBookId] = linked;
          });
          await addBookToShelf(req.calibreConnection.userId, error.existingBookId);
        });
        if (notOwned) {
          if (req.calibreCover?.path) await removeFile(req.calibreCover.path).catch(() => undefined);
          return conflict(res, 'This book belongs to another account');
        }
        if (!linked) {
          if (req.calibreCover?.path) await removeFile(req.calibreCover.path).catch(() => undefined);
          return conflict(res, 'This title already exists in Xandrio');
        }
        const coverStatus = await saveOptionalCover(error.existingBookId, req);
        return res.json({
          success: true,
          status: 'linked',
          coverStatus,
          bookId: error.existingBookId,
          book: publicBookRecord(linked)
        });
      }
      if (req.calibreCover?.path) await removeFile(req.calibreCover.path).catch(() => undefined);
      if (error?.response) return res.status(error.statusCode || 400).json(error.response);
      return storageError(res, error, 'Calibre import failed while processing this book', 'Calibre import failed:');
    }
  });

  return { requireCalibreAccess };
}

module.exports = {
  bearerToken,
  calibreIdentities,
  mergeCalibreMetadata,
  parseMetadataField,
  registerCalibreRoutes
};
