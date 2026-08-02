/**
 * App shell cache-version consistency tests.
 *
 * The service worker only revalidates shell assets when CACHE_VERSION or an
 * ASSET_VERSIONS entry changes, and index.html must reference the same ?v=
 * values sw.js caches — otherwise installed clients keep running stale UI.
 *
 * Run: node test/test-app-shell-versions.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

const publicDir = path.join(__dirname, '..', 'public');
const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const librarySource = fs.readFileSync(path.join(publicDir, 'js', 'views', 'library.js'), 'utf8');

console.log('\n━━━ App shell versions ━━━');

const assetVersionsMatch = swSource.match(/const ASSET_VERSIONS = \{([\s\S]*?)\};/);
assert(assetVersionsMatch, 'sw.js declares ASSET_VERSIONS');

const assetVersions = new Map();
for (const [, assetPath, version] of (assetVersionsMatch?.[1] || '').matchAll(/'([^']+)':\s*(\d+)/g)) {
  assetVersions.set(assetPath, Number(version));
}
assert(assetVersions.size > 0, 'ASSET_VERSIONS lists at least one versioned asset');

for (const [assetPath, version] of assetVersions) {
  const references = [...indexSource.matchAll(
    new RegExp(`["'/]${assetPath.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=(\\d+)["']`, 'g')
  )];
  assert(references.length > 0, `index.html references ${assetPath} with a ?v= query`);
  for (const reference of references) {
    assert(
      Number(reference[1]) === version,
      `index.html ${assetPath}?v=${reference[1]} matches sw.js ASSET_VERSIONS (${version})`
    );
  }
  assert(fs.existsSync(path.join(publicDir, assetPath.slice(1))), `${assetPath} exists in public/`);
}

assert(
  indexSource.indexOf('/js/lifecycle.js') !== -1 &&
    indexSource.indexOf('/js/lifecycle.js') < indexSource.indexOf('/js/chunk-player.js'),
  'index.html loads lifecycle helpers before the classic chunk player'
);

assert(
  appSource.indexOf('await registerServiceWorker()') !== -1 &&
    appSource.indexOf('await registerServiceWorker()') < appSource.indexOf('initializeDOMElements();  //') &&
    appSource.indexOf('await registerServiceWorker()') < appSource.indexOf('initRouter({'),
  'idle-page worker handoff completes before UI handlers or routing can select playback'
);
assert(
  appSource.includes('if (updated.serviceWorkerAllowed) void registerServiceWorker();') &&
    appSource.includes("candidate?.state === 'installed'\n    && Date.now() < deadlineAt\n    && serviceWorkerBootWindowOpen") &&
    appSource.includes('if (!alreadyReloaded && serviceWorkerBootWindowOpen)'),
  'late connectivity may register, while activation and reload stay confined to the pre-router boot window'
);
assert(
  appSource.includes('SERVICE_WORKER_BOOT_DEADLINE_MS = 6000') &&
    appSource.includes('settleBeforeDeadline('),
  'network-dependent worker boot has a hard deadline'
);
{
  const skipWaitingCalls = swSource.match(/\bself\.skipWaiting\s*\(/g) || [];
  assert(
    skipWaitingCalls.length === 1 &&
      swSource.includes("event.data?.type === 'XANDRIO_ACTIVATE_WAITING'") &&
      swSource.indexOf("reason: 'other-clients'") < swSource.indexOf('await self.skipWaiting()') &&
      !swSource.includes('clients.claim()'),
    'service-worker activation is refused while another window client is open'
  );
}
assert(
  swSource.includes('key !== previousShellCache'),
  'activation retains the immediately previous complete shell cache'
);
assert(
  swSource.includes("key.startsWith(`${OFFLINE_AUDIO_CACHE}:`)") &&
    swSource.includes("key.startsWith(`${OFFLINE_TITLE_CACHE}:`)"),
  'service-worker activation preserves account-scoped offline caches'
);
assert(
  swSource.includes('scopedOfflineCacheName(OFFLINE_AUDIO_CACHE, request)') &&
    swSource.includes('scopedOfflineCacheName(OFFLINE_TITLE_CACHE, request)'),
  'offline fallbacks resolve the cache namespace from the request scope'
);
assert(
  swSource.includes("legacyHeaders.set('Content-Length', String(size))") &&
    swSource.includes('cache.put(cacheKey, new Response(buffer'),
  'the first legacy Range request backfills streaming metadata'
);
assert(
  indexSource.includes('id="downloaded-device-hint"') &&
    librarySource.includes("deviceHint.hidden = currentTab !== 'downloaded'"),
  'the populated Downloaded view explains that copies are device-local'
);
// A partial or unverified download used to be filed under Downloaded and
// marked data-downloaded="1". Opening one and having it fail to play is
// exactly the report this work came from.
const availableOnDevice = librarySource.match(
  /function isAvailableOnDevice\(status\) \{([\s\S]*?)\n\}/
)?.[1] || '';
// Most js/ modules in APP_SHELL carry no ?v=, so CACHE_VERSION is their only
// invalidation path. Editing one without bumping it strands installed clients
// on old playback logic while app.js updates around them.
const cacheVersion = swSource.match(/const CACHE_VERSION = '([^']+)'/)?.[1] || '';
assert(/^xandrio-v\d+$/.test(cacheVersion), 'CACHE_VERSION is a recognisable version string');

// The shipped worker and the page's expected build move together. Runtime
// routing accepts the compatible contract during a rolling handoff, while the
// exact script identity still decides whether an update registration is due.
const offlineSource = fs.readFileSync(
  path.join(publicDir, 'js', 'features', 'offline.js'),
  'utf8'
);
const expectedSwVersion = offlineSource
  .match(/export const EXPECTED_OFFLINE_SW_VERSION = '([^']+)'/)?.[1] || '';
assert(
  expectedSwVersion === cacheVersion,
  `offline.js EXPECTED_OFFLINE_SW_VERSION (${expectedSwVersion || 'missing'}) matches sw.js CACHE_VERSION (${cacheVersion})`
);
assert(
  swSource.includes('OFFLINE_SW_VERSION_MARKER') && swSource.includes('CACHE_VERSION);'),
  'the worker stamps its own version on scoped offline responses'
);
// The page can only read `controller.scriptURL`, so registering a versioned URL
// is what makes the controlling worker's build observable. Without it, a new
// app.js cannot tell that the previous (network-first) worker is still in
// charge, and would hand it a scoped URL while claiming local playback.
assert(
  /OFFLINE_WORKER_SCRIPT_URL = `\/sw\.js\?v=\$\{EXPECTED_OFFLINE_SW_VERSION\}`/.test(offlineSource),
  'the registered worker URL is pinned to the expected offline contract version'
);
assert(
  appSource.includes('navigator.serviceWorker.register(OFFLINE_WORKER_SCRIPT_URL)') &&
    !/register\('\/sw\.js'\)/.test(appSource),
  'app.js registers the version-pinned worker URL, not a bare /sw.js'
);
assert(
  appSource.includes(
    'current.compatible && isExpectedOfflineWorker(navigator.serviceWorker.controller)'
  ),
  'a compatible older worker does not suppress registration of the shipped worker build'
);
{
  const { execSync } = require('child_process');
  const git = (command) => {
    try {
      return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const changed = git('git diff --name-only HEAD -- public/').split('\n').filter(Boolean);
  const versionedPaths = new Set([...assetVersions.keys()].map(entry => `public${entry}`));
  const unversionedShellChanged = changed.filter(file =>
    file.startsWith('public/js/') && !versionedPaths.has(file)
  );
  const cacheVersionBumped = git('git diff HEAD -- public/sw.js')
    .split('\n')
    .some(line => /^[+-]const CACHE_VERSION/.test(line));
  assert(
    unversionedShellChanged.length === 0 || cacheVersionBumped,
    'an edited unversioned shell module comes with a CACHE_VERSION bump' +
      (unversionedShellChanged.length ? ` (${unversionedShellChanged.join(', ')})` : '')
  );
}

assert(availableOnDevice.length > 0, 'library.js declares isAvailableOnDevice');
assert(
  !/partial-download|downloading/.test(availableOnDevice),
  'only a fully verified download counts as available on this device'
);
assert(
  indexSource.includes('Audio preparation continues on the server when Xandrio is closed') &&
    indexSource.includes('During the later device download, keep Xandrio visible'),
  'the Downloaded view distinguishes background preparation from foreground transfer'
);
assert(
  swSource.includes("self.addEventListener('push'") &&
    swSource.includes('self.registration.showNotification') &&
    swSource.includes("self.addEventListener('notificationclick'"),
  'the service worker notifies users when server preparation completes'
);

// APP_SHELL entries must exist on disk, or cache.addAll() rejects and the new
// service worker never installs (clients then stay pinned to the old shell).
const appShellMatch = swSource.match(/const APP_SHELL = \[([\s\S]*?)\];/);
assert(appShellMatch, 'sw.js declares APP_SHELL');
const appShellPaths = new Set();
for (const [, shellPath] of (appShellMatch?.[1] || '').matchAll(/'\/([^']+)'/g)) {
  appShellPaths.add(`/${shellPath}`);
  assert(fs.existsSync(path.join(publicDir, shellPath)), `APP_SHELL asset /${shellPath} exists in public/`);
}

// A ?v= reference in index.html to a shell-cached asset that sw.js doesn't
// version either never invalidates or misses the shell cache entirely — it
// must be added to ASSET_VERSIONS. (Assets outside APP_SHELL, like the
// apple-touch icon, are plain browser-cached and exempt.)
for (const [, referencedPath] of indexSource.matchAll(/(?:href|src)="\/?([^"?]+)\?v=\d+"/g)) {
  if (!appShellPaths.has(`/${referencedPath}`)) continue;
  assert(
    assetVersions.has(`/${referencedPath}`),
    `index.html versioned shell asset /${referencedPath} is tracked in sw.js ASSET_VERSIONS`
  );
}

// Every ES module app.js can reach statically must be precached. A module
// missing here is invisible online (the network serves it) and only breaks on
// a cold offline boot, where the import fails and the app never starts.
// chunk-player.js is exempt: index.html loads it as a classic script tag, so
// it is not part of app.js's module graph.
function moduleGraphFrom(entryFile) {
  const reached = new Set();
  const patterns = [
    /(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]/g
  ];
  (function walk(file) {
    if (reached.has(file) || !fs.existsSync(file)) return;
    reached.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (specifier.startsWith('.')) walk(path.resolve(path.dirname(file), specifier));
      }
    }
  })(entryFile);
  return [...reached].map(file => `/${path.relative(publicDir, file)}`).sort();
}

const versionedShellPaths = new Set(
  [...appShellPaths].concat([...assetVersions.keys()])
);
for (const modulePath of moduleGraphFrom(path.join(publicDir, 'app.js'))) {
  assert(
    versionedShellPaths.has(modulePath),
    `app.js module graph entry ${modulePath} is precached in APP_SHELL`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
