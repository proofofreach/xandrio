const assert = require('assert');
const { removeLegacyImportReviewState } = require('../lib/import-state-migration');

const books = {
  old: {
    needsReview: true,
    validationWarnings: ['low confidence'],
    importValidation: { valid: true, needsReview: true, diagnostics: [{ code: 'structure.low-confidence' }] }
  },
  current: { title: 'Current' }
};

assert.strictEqual(removeLegacyImportReviewState(books), true);
assert(!Object.hasOwn(books.old, 'needsReview') && !Object.hasOwn(books.old, 'validationWarnings'));
assert.strictEqual(books.old.importValidation.needsReview, false);
assert.deepStrictEqual(books.old.importValidation.diagnostics, [{ code: 'structure.low-confidence' }]);
assert.strictEqual(removeLegacyImportReviewState(books), false);

console.log('5 passed, 0 failed');
