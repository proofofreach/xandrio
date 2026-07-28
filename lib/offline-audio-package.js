const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;
const { promisify } = require('util');
const { execFile: execFileCallback } = require('child_process');
const { isSafeBookId } = require('./request-guards');

const OFFLINE_AUDIO_BITRATE_KBPS = 48;
const OFFLINE_AUDIO_PACKAGE_VERSION = 1;
const OFFLINE_AUDIO_SAMPLE_RATE = 24000;

function packageVariantKey(sourceVariantKey) {
  return `${String(sourceVariantKey || 'default')}:offline-mp3-v${OFFLINE_AUDIO_PACKAGE_VERSION}:br${OFFLINE_AUDIO_BITRATE_KBPS}k`;
}

function sourceVariantKey(packageKey) {
  const suffix = `:offline-mp3-v${OFFLINE_AUDIO_PACKAGE_VERSION}:br${OFFLINE_AUDIO_BITRATE_KBPS}k`;
  const value = String(packageKey || '');
  if (!value.endsWith(suffix) || value.length <= suffix.length) {
    throw new TypeError('Invalid offline audio package identity');
  }
  return value.slice(0, -suffix.length);
}

function variantDigest(sourceVariantKey) {
  return crypto
    .createHash('sha256')
    .update(packageVariantKey(sourceVariantKey))
    .digest('hex')
    .slice(0, 16);
}

function createOfflineAudioPackage({
  cacheDir,
  fs = fsp,
  execFile = promisify(execFileCallback)
} = {}) {
  if (!cacheDir) throw new TypeError('Offline audio package requires a cache directory');
  if (!fs?.stat || !fs?.rename || !fs?.unlink) {
    throw new TypeError('Offline audio package requires filesystem operations');
  }
  if (typeof execFile !== 'function') {
    throw new TypeError('Offline audio package requires an ffmpeg executor');
  }
  const root = path.resolve(cacheDir);
  const jobs = new Map();

  function chapterPath({ bookId, chapterIndex, sourceVariantKey }) {
    if (!isSafeBookId(bookId)) throw new TypeError('Invalid book identifier');
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      throw new TypeError('Invalid chapter index');
    }
    return path.join(
      root,
      `${bookId}_offline_${variantDigest(sourceVariantKey)}_ch${chapterIndex}.mp3`
    );
  }

  async function inspectChapter(request) {
    const outputPath = chapterPath(request);
    let size = 0;
    try {
      const stat = await fs.stat(outputPath);
      if (stat.isFile?.() !== false) size = Math.max(0, Number(stat.size) || 0);
    } catch {}
    const ready = size > 0;
    return {
      ready,
      size,
      path: outputPath,
      bitrateKbps: OFFLINE_AUDIO_BITRATE_KBPS,
      sampleRate: OFFLINE_AUDIO_SAMPLE_RATE,
      variantKey: packageVariantKey(request.sourceVariantKey),
      url: ready
        ? `/api/offline/audio/${encodeURIComponent(request.bookId)}/${request.chapterIndex}`
        : null
    };
  }

  async function ensureChapter(request) {
    const existing = await inspectChapter(request);
    if (existing.ready) return existing;
    if (!request.sourcePath) throw new TypeError('Offline audio package requires source audio');
    const key = existing.path;
    if (jobs.has(key)) return jobs.get(key);

    const job = (async () => {
      const partPath = `${existing.path}.part`;
      await fs.unlink(partPath).catch(() => {});
      try {
        await execFile('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', request.sourcePath,
          '-map_metadata', '-1',
          '-vn',
          '-ac', '1',
          '-ar', String(OFFLINE_AUDIO_SAMPLE_RATE),
          '-c:a', 'libmp3lame',
          '-b:a', `${OFFLINE_AUDIO_BITRATE_KBPS}k`,
          '-f', 'mp3',
          partPath
        ]);
        const stat = await fs.stat(partPath);
        if (!Number.isFinite(stat.size) || stat.size <= 0) {
          throw new Error('Offline audio transcode produced an empty file');
        }
        await fs.rename(partPath, existing.path);
        return inspectChapter(request);
      } finally {
        await fs.unlink(partPath).catch(() => {});
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  }

  return {
    chapterPath,
    inspectChapter,
    ensureChapter,
    packageVariantKey,
    sourceVariantKey
  };
}

module.exports = {
  OFFLINE_AUDIO_BITRATE_KBPS,
  OFFLINE_AUDIO_PACKAGE_VERSION,
  OFFLINE_AUDIO_SAMPLE_RATE,
  createOfflineAudioPackage,
  packageVariantKey,
  sourceVariantKey
};
