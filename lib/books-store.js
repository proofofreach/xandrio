// Critical persistence adapter for the library catalog. Keeping this separate
// prevents high-frequency reconstructable stores from inheriting backup I/O.

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

function createBooksStore({ filePath, jsonStore, maxBackups = 5 }) {
  if (!filePath) throw new TypeError('filePath is required');
  if (!jsonStore) throw new TypeError('jsonStore is required');
  if (typeof jsonStore.createCriticalStore === 'function') {
    return jsonStore.createCriticalStore({
      filePath,
      defaultValue: {},
      validate: validateBooksStore,
      maxBackups
    });
  }

  const options = { validate: validateBooksStore, throwOnCorrupt: true };
  return {
    filePath,
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
  };
}

module.exports = {
  createBooksStore,
  validateBooksStore
};
