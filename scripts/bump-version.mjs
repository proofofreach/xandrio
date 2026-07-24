#!/usr/bin/env node
// Bump frontend cache-busting versions in lockstep.
//
// Usage: node scripts/bump-version.mjs [asset...]
//   node scripts/bump-version.mjs              # bump app.js + style-v3.css + SW cache
//   node scripts/bump-version.mjs app.js       # bump only app.js (+ SW cache)
//   node scripts/bump-version.mjs chunk-player # bump only chunk-player.js (+ SW cache)
//
// Rewrites the ?v=N query strings in public/index.html and the matching
// APP_SHELL entries in public/sw.js, and always bumps CACHE_VERSION so
// installed PWAs refetch the shell.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(root, 'public', 'index.html');
const swPath = join(root, 'public', 'sw.js');

const KNOWN = ['app.js', 'style-v3.css', 'chunk-player.js'];
const SW_ASSET_KEYS = {
  'app.js': '/app.js',
  'style-v3.css': '/style-v3.css',
  'chunk-player.js': '/js/chunk-player.js'
};
const args = process.argv.slice(2);
const targets = args.length
  ? KNOWN.filter(name => args.some(a => name.includes(a.replace(/^\/?(js\/)?/, '').replace(/\?.*$/, ''))))
  : ['app.js', 'style-v3.css'];

if (args.length && targets.length === 0) {
  console.error(`No known asset matches ${JSON.stringify(args)}. Known: ${KNOWN.join(', ')}`);
  process.exit(1);
}

let indexHtml = readFileSync(indexPath, 'utf8');
let sw = readFileSync(swPath, 'utf8');

for (const name of targets) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped}\\?v=)(\\d+)`, 'g');
  let next = null;
  indexHtml = indexHtml.replace(re, (_, prefix, n) => {
    next = Number(n) + 1;
    return `${prefix}${next}`;
  });
  if (next === null) {
    console.error(`Did not find ${name}?v=N in index.html`);
    process.exit(1);
  }
  const swAssetKey = SW_ASSET_KEYS[name];
  const swVersionRe = new RegExp(`('${swAssetKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*)(\\d+)`);
  if (!swVersionRe.test(sw)) {
    console.error(`Did not find ASSET_VERSIONS entry for ${swAssetKey} in sw.js`);
    process.exit(1);
  }
  sw = sw.replace(swVersionRe, `$1${next}`);
  console.log(`${name} -> v${next}`);
}

// Always bump the SW cache version so clients purge the old app shell.
sw = sw.replace(/(const CACHE_VERSION = 'xandrio-v)(\d+)(')/, (_, pre, n, post) => {
  const next = Number(n) + 1;
  console.log(`CACHE_VERSION -> xandrio-v${next}`);
  return `${pre}${next}${post}`;
});

writeFileSync(indexPath, indexHtml);
writeFileSync(swPath, sw);
console.log('Done. index.html and sw.js updated in lockstep.');
