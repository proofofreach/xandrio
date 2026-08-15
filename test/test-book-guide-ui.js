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
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

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
assert(!index.includes('book-guides-allow-uncertified') && settings.includes('allowUncertified: true'), 'experimental guides permit test runs without exposing certification policy as an operator setting');
assert(index.indexOf('gemini-3.7-flash') < index.indexOf('deepseek/deepseek-v4-flash-0731'), 'settings recommend Gemini 3.7 Flash ahead of the slower DeepSeek routes');
assert(!index.includes('qwen/qwen3.7-flash'), 'settings do not offer Qwen while PPQ lacks an eligible ZDR route');
assert(index.includes('glm-5.2'), 'settings offer a ZDR-capable independent verifier');
assert(settings.includes("'/api/book-guides/config/test'"), 'settings can run a bounded paid provider test');
assert(settings.includes('This acknowledgement applies to the provider configuration, not each title.'), 'provider acknowledgement occurs at configuration time');
assert(library.includes('data-book-guide-tag') && library.includes('Mark as nonfiction'), 'admins can explicitly tag nonfiction titles');
assert(library.includes('data-book-guide=') && library.includes('Study guide'), 'tagged titles expose a study-guide action');
assert(guide.includes('data-guide-tag-nonfiction') && guide.includes("apiSend('PUT', `${guidePath(activeBookId)}/category`"), 'untagged guide state can mark the title as nonfiction without leaving the view');
assert(guide.includes('Mark this title as nonfiction') && guide.includes("status === 'needs-classification'"), 'untagged titles explain the exact eligibility action instead of reporting configuration unavailable');
assert(guide.includes('getCurrentUser') && guide.includes("user.role === 'admin'"), 'guide limits generation controls to administrators');
assert(guide.includes("/cancel") && guide.includes("apiSend('DELETE', guidePath(activeBookId))") && guide.includes("/anchors/${encodeURIComponent(anchorId)}/context"), 'guide supports cancellation, deletion, and source context');
assert(guide.includes('function sourceDisclosure') && guide.includes('<details class="guide-sources">'), 'guide groups evidence anchors behind a source disclosure');
assert(!guide.includes('function anchorButtons'), 'guide does not render every source link in the reading flow');
assert(guide.includes('anchor.audioSeconds') && !guide.includes('seekToSeconds = Number(anchor.timestamp)'), 'guide only seeks when an explicit audio offset exists');
assert(guide.includes('recallQuestions') && guide.includes('Reveal answer') && guide.includes('chapterMap'), 'guide renders recall and chapter-map layers');
assert(guide.includes('Listen to guide') && guide.includes('guide-narration-audio'), 'ready guides expose an audio playlist');
assert(guide.includes('/narration/${encodeURIComponent(section.id)}/audio'), 'guide audio streams section-level TTS from the server');
assert(guide.includes('/narration/status') && guide.includes('readyParts') && guide.includes('totalParts'), 'guide polls real server-reported audio-part progress');
assert(guide.includes('Audio preparation progress') && guide.includes('aria-valuetext'), 'audio preparation exposes accessible progress semantics');
assert(guide.includes("addEventListener('ended'") && guide.includes('playNarrationSection(narrationIndex + 1)'), 'guide audio advances through the section playlist');
assert(guide.includes('data-guide-audio-speed') && guide.includes('playbackRate'), 'guide audio supports independent playback speed');
assert(app.includes('pauseBookPlayback') && guide.includes('deps.pauseBookPlayback?.()'), 'guide narration pauses book playback before starting');
assert(guide.includes('LAST_SECTION_PREFIX') && guide.includes('localStorage.setItem'), 'guide keeps only browser-local section state');

assert(style.includes('grid-template-columns: repeat(5, minmax(0, 1fr))'), 'mobile player utilities support guide access');
assert(style.includes('#guide-view') && style.includes('.guide-source-link'), 'guide has view and source-link styles');
assert(style.includes('.guide-sources > summary') && style.includes('min-height: var(--touch-min)'), 'source disclosures stay quiet while preserving touch targets');
assert(style.includes('.guide-narration') && style.includes('.guide-narration-sections'), 'guide narration has responsive player styles');
assert(style.includes('.guide-narration-progress') && style.includes('prefers-reduced-motion'), 'guide narration progress is visible and motion-safe');

assert(index.includes('id="book-guides-settings-section"') && index.includes('id="book-guides-key-note"'), 'settings disclose provider cost and write-only key handling');
assert(index.includes('id="book-guides-device-connection"') && index.includes('id="book-guides-login-sheet"'), 'settings include a deployment-gated device authorization flow');
assert(settings.includes("'/api/book-guides/provider/login'") && settings.includes("'/api/book-guides/provider/connection'"), 'settings connect and poll without receiving an OAuth token');
assert(settings.includes("config.authMode === 'device'") && settings.includes('bookGuidesApiKeyGroup.hidden = deviceAuth'), 'device authorization replaces rather than duplicates the API-key field');
assert(server.includes("process.env.XANDRIO_PRIVATE_CODEX_GUIDES === '1'") && server.includes('createCodexBookGuideProvider'), 'Codex subscription access is disabled unless the private deployment flag is explicit');
assert(!index.toLowerCase().includes('certif') && !settings.includes('Needs certification') && !guide.includes('Uncertified evaluation run'), 'operator UI does not expose internal certification terminology');
assert(settings.includes("apiGet('/api/book-guides/config')") && settings.includes("apiSend('PUT', '/api/book-guides/config'") && settings.includes("apiSend('DELETE', '/api/book-guides/config')"), 'admin settings load, save, and clear guide configuration');
assert(settings.includes("user.role !== 'admin'") && settings.includes("err.status === 403"), 'guide settings remain hidden from non-admin users');
assert(guide.includes('await refreshGuideState();'), 'generation refreshes the canonical server state');
assert(index.includes('id="guide-btn"') && index.includes('id="utility-guide-btn"') && guide.includes("toggleAttribute('hidden', !showEntry)"), 'player guide entry points follow feature or artifact availability');
assert(guide.includes('existing guide remains available'), 'disabling generation preserves existing guide access');
assert(guide.includes('Could not create the guide'), 'guide renders actionable server failure details');
assert(guide.includes('progressMeta') && guide.includes('Pass ${Number(progress.attempt)') && guide.includes('etaSeconds'), 'guide reports pass, resumed work, and a live ETA');
assert(guide.includes('You can leave this page.') && guide.includes('Guide creation continues on the server.') && guide.includes('href="#/library">Browse library</a>'), 'guide generation explains background processing and provides a library exit');

console.log('56 passed, 0 failed');
