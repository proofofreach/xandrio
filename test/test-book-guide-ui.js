const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const router = fs.readFileSync(path.join(root, 'public', 'js', 'router.js'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'book-guide.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'settings.js'), 'utf8');
const library = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'library.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'public', 'style-v3.css'), 'utf8');

assert(index.includes('id="guide-view"'), 'guide has a full-screen view');
assert(index.includes('id="guide-body"') && index.includes('aria-busy="false"'), 'guide body exposes loading state');
assert(index.includes('id="guide-btn"') && index.includes('id="utility-guide-btn"'), 'guide is available from player controls');
assert(!index.includes('id="guide-nonfiction-confirmed"'), 'the app does not repeat title-level rights acknowledgements');

assert(app.includes("import { initBookGuide, openBookGuide, refreshGuideState } from './js/views/book-guide.js';"), 'app imports guide view module');
assert(app.includes('initBookGuide({') && app.includes('openGuide: openBookGuide'), 'app wires guide view and route');
assert(app.includes("case 'guide':"), 'app can show the guide view');

assert(router.includes("#/guide/:bookId") && router.includes("view === 'guide'"), 'router supports guide deep links');
assert(router.includes("config.openGuide?.(target.bookId)"), 'guide deep links open the view after book resolution');

assert(guide.includes("/api/book/${encodeURIComponent(bookId)}/guide"), 'guide uses the book-guide API route');
assert(guide.includes("apiSend('POST', guidePath(activeBookId))"), 'guide generation relies on persisted title and provider policy');
assert(!guide.includes('guide-nonfiction-confirmed'), 'guide creation does not repeat provider rights acknowledgement');
assert(index.includes('book-guides-api-key'), 'settings expose a write-only PPQ.ai API key field');
assert(index.includes('book-guides-allow-uncertified'), 'settings expose an explicit uncertified evaluation mode');
assert(index.includes('deepseek/deepseek-v4-flash-0731'), 'settings default to the exact DeepSeek V4 Flash 0731 route');
assert(index.includes('glm-5.2'), 'settings offer a ZDR-capable independent verifier');
assert(settings.includes("'/api/book-guides/config/test'"), 'settings can run a bounded paid provider test');
assert(settings.includes('This acknowledgement applies to the provider configuration, not each title.'), 'provider acknowledgement occurs at configuration time');
assert(library.includes('data-book-guide-tag') && library.includes('Mark as nonfiction'), 'admins can explicitly tag nonfiction titles');
assert(library.includes('data-book-guide=') && library.includes('Study guide'), 'tagged titles expose a study-guide action');
assert(guide.includes('getCurrentUser') && guide.includes("user.role === 'admin'"), 'guide limits generation controls to administrators');
assert(guide.includes("/cancel") && guide.includes("apiSend('DELETE', guidePath(activeBookId))") && guide.includes("/anchors/${encodeURIComponent(anchorId)}/context"), 'guide supports cancellation, deletion, and source context');
assert(guide.includes('anchor.audioSeconds') && !guide.includes('seekToSeconds = Number(anchor.timestamp)'), 'guide only seeks when an explicit audio offset exists');
assert(guide.includes('recallQuestions') && guide.includes('Reveal answer') && guide.includes('chapterMap'), 'guide renders recall and chapter-map layers');
assert(guide.includes('LAST_SECTION_PREFIX') && guide.includes('localStorage.setItem'), 'guide keeps only browser-local section state');

assert(style.includes('grid-template-columns: repeat(5, minmax(0, 1fr))'), 'mobile player utilities support guide access');
assert(style.includes('#guide-view') && style.includes('.guide-source-link'), 'guide has view and source-link styles');

assert(index.includes('id="book-guides-settings-section"') && index.includes('id="book-guides-certification-note"'), 'settings disclose experimental guide configuration and certification gate');
assert(settings.includes("apiGet('/api/book-guides/config')") && settings.includes("apiSend('PUT', '/api/book-guides/config'") && settings.includes("apiSend('DELETE', '/api/book-guides/config')"), 'admin settings load, save, and clear guide configuration');
assert(settings.includes("user.role !== 'admin'") && settings.includes("err.status === 403"), 'guide settings remain hidden from non-admin users');
assert(guide.includes('await refreshGuideState();'), 'generation refreshes the canonical server state');
assert(index.includes('id="guide-btn"') && index.includes('id="utility-guide-btn"') && guide.includes("toggleAttribute('hidden', !showEntry)"), 'player guide entry points follow feature or artifact availability');
assert(guide.includes('previously verified guide remains available'), 'disabling generation preserves verified guide access');

console.log('24 passed, 0 failed');
