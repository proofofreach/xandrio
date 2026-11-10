// Critical persistence adapter for the library catalog. Keeping this separate
// prevents high-frequency reconstructable stores from inheriting backup I/O.

const { normalizeLibraryLanguages } = require('./book-language');

function validateBooksStore(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'top level must be an object';
  }
  for (const [bookId, book] of Object.entries(raw)) {
    if (!bookId) return 'book ids must not be empty';
    if (book === null || typeof book !== 'object' || Array.isArray(book)) {
      return `book ${bookId} must be an object`;
    }
    // Early libraries may omit the redundant id field. When present it must
    // agree with the catalog key so updates cannot target the wrong record.
    if (book.id !== undefined && book.id !== bookId) {
      return `book ${bookId} has an id that does not match its key`;
    }
  }
  return true;
}

// Records written before import normalized `language` (en-US, EN, eng,
// English) are canonicalized as they are read, so every consumer sees one
// spelling and the next write persists it without a data migration.
function withCanonicalLanguages(store) {
  return {
    ...store,
    load: async (...args) => normalizeLibraryLanguages(await store.load(...args)),
    save: data => store.save(normalizeLibraryLanguages(data)),
    update: mutator => store.update(books => mutator(normalizeLibraryLanguages(books)))
  };
}

function createBooksStore({ filePath, jsonStore, maxBackups = 5 }) {
  if (!filePath) throw new TypeError('filePath is required');
  if (!jsonStore) throw new TypeError('jsonStore is required');
  // Registering binds the path itself, so modules that call jsonStore.load()
  // or update() on books.json directly get the same fail-closed store.
  const create = typeof jsonStore.registerCriticalStore === 'function'
    ? jsonStore.registerCriticalStore
    : jsonStore.createCriticalStore;
  if (typeof create === 'function') {
    return withCanonicalLanguages(create({
      filePath,
      defaultValue: {},
      validate: validateBooksStore,
      maxBackups
    }));
  }

  const options = { validate: validateBooksStore, throwOnCorrupt: true };
  return withCanonicalLanguages({
    filePath,
    validate: validateBooksStore,
    load: () => jsonStore.load(filePath, {}, options),
    save: data => jsonStore.save(filePath, data, options),
    update: mutator => jsonStore.update(filePath, mutator, {}, options),
    listRecoveryCandidates: () =>
      jsonStore.listRecoveryCandidates(filePath, { validate: validateBooksStore }),
    restore: candidatePath =>
      jsonStore.restoreRecoveryCandidate(filePath, candidatePath, {
        validate: validateBooksStore,
        maxBackups
      })
  });
}

module.exports = {
  createBooksStore,
  validateBooksStore
};
