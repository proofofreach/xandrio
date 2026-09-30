const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const searchSource = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'search.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'public', 'style-v3.css'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const bookmarksSource = fs.readFileSync(path.join(root, 'public', 'js', 'features', 'bookmarks.js'), 'utf8');

assert(!searchSource.includes('renderImportReview'),
  'successful imports do not render a review screen');
assert(!searchSource.includes('lastImportReviewResultsHtml') && !searchSource.includes('data-import-action'),
  'successful imports have no review state or review actions');
assert(!searchSource.includes('needsReview') && !searchSource.includes('validationWarnings'),
  'successful import navigation does not branch on internal diagnostics');
assert(
  searchSource.includes('await deps.openBook(bookId)') &&
    !searchSource.includes("deps.navigateTo?.('library');\n  deps.openBook"),
  'successful uploads and downloads open the imported book immediately'
);

assert(!indexSource.includes('PDF chapters need review') && !indexSource.includes('pdf-structure-review'),
  'the player has no PDF review warning');
assert(indexSource.includes('id="rebuild-chapters-btn"') && indexSource.includes('Rebuild chapters'),
  'the player exposes a neutral chapter rebuild action');
assert(!styleSource.includes('.import-review-') && !styleSource.includes('.pdf-structure-review'),
  'obsolete review UI styles are removed');
assert(!appSource.includes('pdfExtraction') && !appSource.includes('pdfReprocessable'),
  'the player does not expose extraction confidence or format-specific rebuild policy');
assert(appSource.includes('/rebuild-chapters'),
  'the neutral action uses the generic rebuild endpoint');
assert(appSource.includes('characterOffset: playbackCharacterOffset(checkpoint),\n    positionApproximate: true'),
  'time-derived playback character offsets are explicitly approximate');
assert(bookmarksSource.includes('characterOffset: deps.getCharacterOffset?.(),\n      positionApproximate: true'),
  'time-derived bookmark character offsets are explicitly approximate');
assert(appSource.includes('if (!chapterTextLength || !checkpoint) return undefined;') &&
  appSource.includes('if (!duration || !Number.isFinite(timestamp)) return undefined;'),
  'the player omits a character offset when no timing estimate is available');

const publicFieldsSource = serverSource.match(/const PUBLIC_BOOK_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
assert(publicFieldsSource, 'public book serialization uses an explicit field list');
const publicFields = new Set([...publicFieldsSource[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
for (const privateField of ['needsReview', 'validationWarnings', 'importValidation', 'pdfExtraction', 'sourceRecovery']) {
  assert(!publicFields.has(privateField),
    `public book serialization excludes ${privateField}`);
}

console.log('16 passed, 0 failed');
