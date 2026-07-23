#!/usr/bin/env node
/**
 * Delete orphaned TTS cache audio — files whose `_tts{hash}` variant segment
 * no longer matches any variant key the server can produce today. Variant
 * keys change whenever the audio pipeline, engine, profile, format, or
 * paragraph-pause settings change, leaving the previous generation of chunk /
 * chapter files stranded on disk.
 *
 * Safe by construction: only touches files whose name contains a `_tts` +
 * 10-hex variant segment (always derived audio: chunks, chapter mp3/wav/m4a,
 * .texthash sidecars, concat lists). Source files ({id}.epub, {id}.xbook.json,
 * {id}_cover.jpg) and legacy no-variant `_ch*` files never match.
 *
 * Usage:
 *   node scripts/clean-tts-orphans.js           # dry run (report only)
 *   node scripts/clean-tts-orphans.js --delete  # actually delete
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getKokoroVariantKey, isKokoroVoice } = require('../lib/kokoro-tuning');
const { getChatterboxVariantKey, isChatterboxVoice } = require('../lib/chatterbox-tuning');
const { AUDIO_PIPELINE_VERSION } = require('../lib/tts-engine-profile');
const { getMasteringBitrate } = require('../lib/audio-quality');
const { getTtsOutputFormatForVoice } = require('../lib/tts-output-format');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'cache');
const CUSTOM_VOICES_FILE = path.join(ROOT, 'data', 'custom-voices.json');
const SERVER_URL = process.env.XANDRIO_URL || 'http://localhost:8181';
const PROFILES = ['quality', 'balanced', 'fast'];
const EDGE_DEFAULT_CHUNK_SIZE = 4000; // DEFAULT_CHUNK_SIZE in lib/chunked-tts.js

const doDelete = process.argv.includes('--delete');

function segmentFor(variantKey) {
  // Mirrors ChunkedTTS.variantSegment()
  return `_tts${crypto.createHash('sha1').update(String(variantKey)).digest('hex').slice(0, 10)}`;
}

function customRefVersion(voiceId) {
  // Mirrors server.js getChatterboxRefVersionSync()
  try {
    const registry = JSON.parse(fs.readFileSync(CUSTOM_VOICES_FILE, 'utf8'));
    const localId = String(voiceId).slice('chatterbox:'.length);
    return (registry.voices || []).find(v => v?.id === localId)?.refVersion || null;
  } catch {
    return null;
  }
}

async function collectValidSegments() {
  const res = await fetch(`${SERVER_URL}/api/voices`);
  if (!res.ok) throw new Error(`GET /api/voices failed: ${res.status}`);
  const { voices } = await res.json();
  if (!Array.isArray(voices) || voices.length === 0) throw new Error('No voices returned');

  const keys = new Set();
  for (const v of voices) {
    const id = v.id;
    if (isKokoroVoice(id)) {
      keys.add(getKokoroVariantKey(id)); // server calls with no profile option
      for (const profile of PROFILES) keys.add(getKokoroVariantKey(id, { profile }));
    } else if (isChatterboxVoice(id)) {
      const ref = customRefVersion(id);
      const base = [getChatterboxVariantKey(id), ...PROFILES.map(p => getChatterboxVariantKey(id, { profile: p }))];
      for (const key of base) keys.add(ref ? `${key}:ref${ref}` : key);
    } else {
      // Edge voices: server.js getTTSVariantKeyForVoice fallback
      keys.add(`${id}:chunk${EDGE_DEFAULT_CHUNK_SIZE}:out${getTtsOutputFormatForVoice(id)}:audio${AUDIO_PIPELINE_VERSION}:br${getMasteringBitrate()}`);
    }
  }
  return new Set([...keys].map(segmentFor));
}

async function main() {
  const valid = await collectValidSegments();
  console.log(`${valid.size} currently-producible variant segments`);

  const entries = fs.readdirSync(CACHE_DIR);
  const byHash = new Map(); // segment -> {files, bytes}
  for (const name of entries) {
    const m = name.match(/(_tts[0-9a-f]{10})(?=_)/);
    if (!m) continue;
    const seg = m[1];
    if (valid.has(seg)) continue;
    const full = path.join(CACHE_DIR, name);
    const size = fs.statSync(full).size;
    const bucket = byHash.get(seg) || { files: [], bytes: 0 };
    bucket.files.push(full);
    bucket.bytes += size;
    byHash.set(seg, bucket);
  }

  let totalFiles = 0, totalBytes = 0;
  for (const [seg, { files, bytes }] of [...byHash.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`orphan ${seg}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
    totalFiles += files.length;
    totalBytes += bytes;
  }
  console.log(`TOTAL: ${totalFiles} files, ${(totalBytes / 1e6).toFixed(1)} MB across ${byHash.size} stale variants`);

  if (!doDelete) {
    console.log('\nDry run — pass --delete to remove these files.');
    return;
  }
  for (const { files } of byHash.values()) {
    for (const f of files) fs.unlinkSync(f);
  }
  console.log(`Deleted ${totalFiles} files.`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
