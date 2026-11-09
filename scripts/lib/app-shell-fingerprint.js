'use strict';
// Content fingerprint of every file the service worker precaches under
// CACHE_VERSION. Installed clients only refetch the shell when CACHE_VERSION
// changes, so any change to these bytes must ship with a bump. The recorded
// fingerprint is written by scripts/bump-version.mjs and checked by
// test/test-app-shell-versions.js; it needs no git history, so it holds in a
// shallow CI clone and on a clean tree alike.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const FINGERPRINT_FILE = 'app-shell-fingerprint.json';

// '/' is served from index.html, which APP_SHELL also lists explicitly.
function appShellFiles(swSource) {
  const block = swSource.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  if (!block) throw new Error('Missing APP_SHELL in sw.js');
  const files = new Set();
  for (const [, shellPath] of block[1].matchAll(/['"]\/([^'"?]+)['"]/g)) files.add(shellPath);
  return [...files].sort();
}

function computeAppShellFingerprint(publicDir) {
  const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  const files = appShellFiles(swSource);
  const digest = createHash('sha256');
  const perFile = {};
  for (const file of files) {
    const fileDigest = createHash('sha256').update(fs.readFileSync(path.join(publicDir, file))).digest('hex');
    perFile[`/${file}`] = fileDigest;
    digest.update(`/${file}\0${fileDigest}\n`);
  }
  return { sha256: digest.digest('hex'), files: perFile };
}

function readRecordedFingerprint(scriptsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(scriptsDir, FINGERPRINT_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeRecordedFingerprint(scriptsDir, cacheVersion, fingerprint) {
  const record = { cacheVersion, sha256: fingerprint.sha256, files: fingerprint.files };
  fs.writeFileSync(path.join(scriptsDir, FINGERPRINT_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

module.exports = {
  FINGERPRINT_FILE,
  appShellFiles,
  computeAppShellFingerprint,
  readRecordedFingerprint,
  writeRecordedFingerprint
};
