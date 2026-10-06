#!/usr/bin/env node
// Bump every versioned shell asset, or the explicit asset paths, in lockstep.
// Usage: node scripts/bump-version.mjs [asset...]
// Unversioned modules invalidate through the worker cache and controller pin.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(root, 'public', 'index.html');
const swPath = join(root, 'public', 'sw.js');
const offlinePath = join(root, 'public', 'js', 'features', 'offline.js');
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fail(message) {
  console.error(message);
  process.exit(1);
}

let indexHtml = readFileSync(indexPath, 'utf8');
let sw = readFileSync(swPath, 'utf8');
let offline = readFileSync(offlinePath, 'utf8');
const mapBlocks = [...sw.matchAll(/const ASSET_VERSIONS = \{([\s\S]*?)\};/g)];
if (mapBlocks.length !== 1) fail('Expected one ASSET_VERSIONS map in sw.js');
const entries = [...mapBlocks[0][1].matchAll(/['"]([^'"]+)['"]:\s*(\d+)/g)];
const versions = new Map(entries.map(([, path, version]) => [path, Number(version)]));
if (!versions.size || versions.size !== entries.length) fail('Missing or duplicate ASSET_VERSIONS entries');
const shellBlock = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
if (!shellBlock) fail('Missing APP_SHELL in sw.js');
const shellPaths = [...shellBlock[1].matchAll(/versionedAsset\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
if (shellPaths.length !== versions.size || new Set(shellPaths).size !== shellPaths.length || shellPaths.some(path => !versions.has(path))) {
  fail('ASSET_VERSIONS and versioned APP_SHELL entries do not match');
}

// Validate the entire contract before changing any file. A partial selection
// cannot conceal a stale stylesheet, missing shell entry or controller pin.
const htmlAssets = [...indexHtml.matchAll(/(?:src|href)=["']\/?([^"'?]+)\?v=(\d+)["']/g)]
  .map(([, path, version]) => ({ path: `/${path}`, version: Number(version) }));
for (const [path, version] of versions) {
  const references = htmlAssets.filter(asset => asset.path === path);
  if (!references.length || references.some(asset => asset.version !== version)) {
    fail(`index.html and ASSET_VERSIONS disagree for ${path}`);
  }
}
for (const asset of htmlAssets) {
  if (/\.(?:css|js)$/.test(asset.path) && !versions.has(asset.path)) fail(`Versioned shell asset missing from ASSET_VERSIONS: ${asset.path}`);
}
const cacheMatches = [...sw.matchAll(/const CACHE_VERSION = '(xandrio-v(\d+))';/g)];
const pinMatches = [...offline.matchAll(/export const EXPECTED_OFFLINE_SW_VERSION = '([^']+)';/g)];
if (cacheMatches.length !== 1 || pinMatches.length !== 1 || cacheMatches[0][1] !== pinMatches[0][1]) {
  fail('Worker cache version and offline controller pin do not match');
}

const args = process.argv.slice(2);
const targets = args.length ? new Set() : new Set(versions.keys());
for (const arg of args) {
  const normalized = arg.replace(/^\/?public\//, '').replace(/^\//, '').replace(/\?.*$/, '');
  const matches = [...versions.keys()].filter(path => path.slice(1) === normalized || basename(path) === normalized);
  if (matches.length !== 1) fail(`Unknown or ambiguous asset ${JSON.stringify(arg)}. Known: ${[...versions.keys()].join(', ')}`);
  targets.add(matches[0]);
}
for (const path of targets) {
  const next = versions.get(path) + 1;
  const htmlRE = new RegExp(`((?:src|href)=["']/?${escapeRE(path.slice(1))}\\?v=)\\d+`, 'g');
  indexHtml = indexHtml.replace(htmlRE, (_, prefix) => `${prefix}${next}`);
  const mapRE = new RegExp(`(['"]${escapeRE(path)}['"]:\\s*)\\d+`);
  sw = sw.replace(mapRE, (_, prefix) => `${prefix}${next}`);
  console.log(`${path} -> v${next}`);
}
const cacheVersion = `xandrio-v${Number(cacheMatches[0][2]) + 1}`;
sw = sw.replace(/const CACHE_VERSION = 'xandrio-v\d+';/, `const CACHE_VERSION = '${cacheVersion}';`);
offline = offline.replace(/export const EXPECTED_OFFLINE_SW_VERSION = '[^']+';/, `export const EXPECTED_OFFLINE_SW_VERSION = '${cacheVersion}';`);
writeFileSync(indexPath, indexHtml);
writeFileSync(swPath, sw);
writeFileSync(offlinePath, offline);
console.log(`CACHE_VERSION -> ${cacheVersion}. Shell assets and controller pin updated in lockstep.`);
