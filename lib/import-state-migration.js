function removeLegacyImportReviewState(books = {}) {
  let changed = false;
  for (const book of Object.values(books || {})) {
    if (!book || typeof book !== 'object') continue;
    if (Object.hasOwn(book, 'needsReview')) {
      delete book.needsReview;
      changed = true;
    }
    if (Object.hasOwn(book, 'validationWarnings')) {
      delete book.validationWarnings;
      changed = true;
    }
    if (book.importValidation?.needsReview) {
      book.importValidation.needsReview = false;
      changed = true;
    }
  }
  return changed;
}

module.exports = { removeLegacyImportReviewState };
