#!/usr/bin/env node
'use strict';

// Before artifact publication used hard links, every verified chunk was stored
// twice: once at its playback path and once as a full copy in the per-book
// narration artifact store. This replaces each copy with a hard link to the
// playback file when both hold identical bytes (sha256 checked on both).
//
// Safe while the server runs: outputs and artifacts are only ever replaced by
// atomic rename, and the link is published the same way. Dry run by default.
//
// Usage: node scripts/dedupe-narration-artifacts.js --cache-dir <dir> [--apply]
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { sha256File } = require('../lib/narration-artifact-cache');

const ARTIFACT_DIR_SUFFIX = '_narration_artifacts_v1';
const ARTIFACT_FILE = /^([a-f0-9]{64})\.(mp3|wav)$/;

function argumentsFor(argv) {
  const options = { cacheDir: null, apply: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--apply') options.apply = true;
    else if (argv[index] === '--cache-dir' && argv[index + 1]) options.cacheDir = path.resolve(argv[++index]);
    else throw new Error('Usage: dedupe-narration-artifacts.js --cache-dir <dir> [--apply]');
  }
  if (!options.cacheDir) throw new Error('--cache-dir is required');
  return options;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readMarker(filePath) {
  try {
    return JSON.parse(await fsp.readFile(`${filePath}.narration-artifact.json`, 'utf8'));
  } catch {
    return null;
  }
}

async function dedupe({ cacheDir, apply = false, log = console.log }) {
  const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  const topLevel = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const summary = { artifacts: 0, linked: 0, alreadyShared: 0, unmatched: 0, mismatched: 0, bytes: 0 };

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(ARTIFACT_DIR_SUFFIX)) continue;
    const bookId = entry.name.slice(0, -ARTIFACT_DIR_SUFFIX.length);
    const outputPattern = new RegExp(`^${escapeRegExp(bookId)}(?:_tts[a-f0-9]{10})?_ch(\\d+)_chunk\\d+\\.(?:mp3|wav)$`);
    // fingerprint -> playback outputs claiming it, per chapter.
    const outputsByChapter = new Map();
    for (const name of topLevel) {
      const match = name.match(outputPattern);
      if (!match) continue;
      const list = outputsByChapter.get(match[1]) || [];
      list.push(path.join(cacheDir, name));
      outputsByChapter.set(match[1], list);
    }

    const bookDir = path.join(cacheDir, entry.name);
    for (const chapter of await fsp.readdir(bookDir, { withFileTypes: true })) {
      const chapterMatch = chapter.isDirectory() && chapter.name.match(/^ch(\d+)$/);
      if (!chapterMatch) continue;
      const chapterDir = path.join(bookDir, chapter.name);
      const fingerprints = new Map();
      for (const outputPath of outputsByChapter.get(chapterMatch[1]) || []) {
        const marker = await readMarker(outputPath);
        if (marker?.fingerprint && !fingerprints.has(marker.fingerprint)) fingerprints.set(marker.fingerprint, outputPath);
      }

      for (const name of await fsp.readdir(chapterDir)) {
        const artifactMatch = name.match(ARTIFACT_FILE);
        if (!artifactMatch) continue;
        summary.artifacts += 1;
        const artifactPath = path.join(chapterDir, name);
        const outputPath = fingerprints.get(artifactMatch[1]);
        if (!outputPath || path.extname(outputPath).slice(1) !== artifactMatch[2]) {
          summary.unmatched += 1;
          continue;
        }
        const [artifactStat, outputStat] = await Promise.all([
          fsp.lstat(artifactPath).catch(() => null),
          fsp.lstat(outputPath).catch(() => null)
        ]);
        if (!artifactStat?.isFile() || !outputStat?.isFile()) continue;
        if (artifactStat.dev === outputStat.dev && artifactStat.ino === outputStat.ino) {
          summary.alreadyShared += 1;
          continue;
        }
        if (artifactStat.size !== outputStat.size) {
          summary.mismatched += 1;
          continue;
        }
        const [artifactHash, outputHash] = await Promise.all([sha256File(artifactPath), sha256File(outputPath)]);
        if (!artifactHash || artifactHash.contentHash !== outputHash?.contentHash) {
          summary.mismatched += 1;
          continue;
        }
        if (apply) {
          const temporaryPath = `${artifactPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
          try {
            await fsp.link(outputPath, temporaryPath);
            await fsp.rename(temporaryPath, artifactPath);
          } finally {
            await fsp.rm(temporaryPath, { force: true });
          }
        }
        summary.linked += 1;
        // Space returns only if no other path still holds the old copy.
        if (artifactStat.nlink === 1) summary.bytes += artifactStat.size;
      }
    }
  }

  const gib = (summary.bytes / 1024 ** 3).toFixed(2);
  log(`${apply ? 'Linked' : 'Would link'} ${summary.linked} of ${summary.artifacts} artifacts, ` +
    `${apply ? 'reclaiming' : 'reclaimable'} ${gib} GiB ` +
    `(${summary.alreadyShared} already shared, ${summary.unmatched} without a playback file, ${summary.mismatched} with different bytes).`);
  return summary;
}

if (require.main === module) {
  dedupe(argumentsFor(process.argv.slice(2))).catch(error => {
    console.error(`dedupe-narration-artifacts: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { dedupe };
