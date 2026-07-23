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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
