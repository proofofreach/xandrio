'use strict';

// Generated narration audio is a regenerable cache, but nothing used to bound
// it: production filled its disk and imports failed with ENOSPC. This module
// keeps a free-space floor by evicting whole chapters, least recently used
// first, across every narration variant and the shared artifact store.
//
// Only derived audio is eligible. Sources, extracted text, covers, offline
// packages and in-progress temporaries never match the patterns below.
//
// Recency comes mainly from recorded use. File access times are a secondary
// signal only: the startup artifact backfill hashes every current-voice chunk,
// so atime can make a chapter look newer than it is but never older.
const fs = require('node:fs');
const path = require('node:path');

const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;
const USAGE_RETENTION_MS = 365 * 24 * HOUR_MS;
const ARTIFACT_DIR_SUFFIX = '_narration_artifacts_v1';
const TOP_LEVEL_AUDIO = new RegExp(
  '^(.+?)(?:_tts[a-f0-9]{10})?_ch(\\d+)(?:' +
    '_chunk\\d+\\.(?:mp3|wav)(?:\\.narration-artifact\\.json)?' +
    '|\\.(?:mp3|wav|m4a)(?:\\.narration-artifact\\.json)?' +
    '|\\.texthash' +
    '|_concat(?:_clean)?\\.txt' +
  ')$'
);
// Offline packages carry their own integrity pointers and readiness records.
const OFFLINE_SEGMENT = /_offline(?:-ready)?_[a-f0-9]+/;
const ARTIFACT_FILE = /^[a-f0-9]{64}\.(?:mp3|wav)(?:\.narration-artifact\.json)?$/;

function insufficientStorageError() {
  return Object.assign(
    new Error('Server storage is full. Try again later.'),
    { code: 'INSUFFICIENT_STORAGE', status: 507 }
  );
}

function formatBytes(bytes) {
  return `${(Math.max(0, bytes) / GIB).toFixed(2)} GiB`;
}

function usageKey(bookId, chapterIndex) {
  return `${bookId}\0${chapterIndex}`;
}

function createAudioCacheBudget({
  cacheDir,
  workers = () => [],
  usageFile = null,
  jsonStore = null,
  minFreeBytes = 5 * GIB,
  minFreeRatio = 0.1,
  hardFloorBytes = GIB,
  protectMs = 48 * HOUR_MS,
  intervalMs = 10 * 60 * 1000,
  fsp = fs.promises,
  now = () => Date.now(),
  log = console
} = {}) {
  if (!cacheDir) throw new TypeError('Audio cache budget requires cacheDir');
  const usage = new Map();
  let usageLoaded = !usageFile;
  let usageDirty = false;
  let running = null;
  let timer = null;

  async function loadUsage() {
    if (usageLoaded) return;
    usageLoaded = true;
    try {
      const stored = await jsonStore.load(usageFile, {});
      for (const [key, value] of Object.entries(stored?.chapters || {})) {
        const recorded = Number(value);
        if (Number.isFinite(recorded) && recorded > (usage.get(key) || 0)) usage.set(key, recorded);
      }
    } catch (error) {
      log.warn?.(`[audio-cache] Usage history unavailable: ${error.message}`);
    }
  }

  async function flushUsage() {
    if (!usageFile || !usageDirty) return;
    usageDirty = false;
    const oldest = now() - USAGE_RETENTION_MS;
    const chapters = {};
    for (const [key, value] of usage) {
      if (value >= oldest) chapters[key] = value;
      else usage.delete(key);
    }
    try {
      await jsonStore.save(usageFile, { version: 1, chapters });
    } catch (error) {
      usageDirty = true;
      log.warn?.(`[audio-cache] Could not save usage history: ${error.message}`);
    }
  }

  function recordUse(bookId, chapterIndex) {
    if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) return;
    usage.set(usageKey(bookId, chapterIndex), now());
    usageDirty = true;
  }

  async function diskSpace() {
    const stat = await fsp.statfs(cacheDir);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const available = Number(stat.bavail) * Number(stat.bsize);
    const lowWater = Math.max(minFreeBytes, total * minFreeRatio);
    return { total, available, lowWater, highWater: Math.min(total, lowWater * 1.5) };
  }

  function groupFor(groups, bookId, chapterIndex) {
    const key = usageKey(bookId, chapterIndex);
    let group = groups.get(key);
    if (!group) {
      group = { bookId, chapterIndex, files: [], artifactDir: null, lastUsedMs: usage.get(key) || 0 };
      groups.set(key, group);
    }
    return group;
  }

  async function addFile(group, filePath) {
    const stat = await fsp.lstat(filePath).catch(() => null);
    if (!stat?.isFile()) return;
    group.files.push({ path: filePath, size: stat.size, ino: `${stat.dev}:${stat.ino}`, nlink: stat.nlink });
    group.lastUsedMs = Math.max(group.lastUsedMs, stat.mtimeMs, stat.atimeMs);
  }

  async function scanArtifactDirectory(groups, bookId, directory) {
    const chapters = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(chapters.map(async chapter => {
      const match = chapter.isDirectory() && chapter.name.match(/^ch(\d+)$/);
      if (!match) return;
      const group = groupFor(groups, bookId, Number(match[1]));
      group.artifactDir = path.join(directory, chapter.name);
      const files = await fsp.readdir(group.artifactDir).catch(() => []);
      await Promise.all(files
        .filter(name => ARTIFACT_FILE.test(name))
        .map(name => addFile(group, path.join(group.artifactDir, name))));
    }));
  }

  async function scan() {
    await loadUsage();
    const groups = new Map();
    const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
    const pending = [];
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(ARTIFACT_DIR_SUFFIX)) {
        const bookId = entry.name.slice(0, -ARTIFACT_DIR_SUFFIX.length);
        pending.push(scanArtifactDirectory(groups, bookId, path.join(cacheDir, entry.name)));
        continue;
      }
      if (!entry.isFile() || OFFLINE_SEGMENT.test(entry.name)) continue;
      const match = entry.name.match(TOP_LEVEL_AUDIO);
      if (!match) continue;
      pending.push(addFile(groupFor(groups, match[1], Number(match[2])), path.join(cacheDir, entry.name)));
    }
    // addFile tolerates vanished files, so one failed stat cannot abort the scan.
    await Promise.allSettled(pending);
    return [...groups.values()].filter(group => group.files.length);
  }

  // Hard links are counted once, and only when every link is in the group,
  // because deleting the group frees nothing while another path survives.
  function reclaimableBytes(group) {
    const inodes = new Map();
    for (const file of group.files) {
      const seen = inodes.get(file.ino) || { size: file.size, nlink: file.nlink, count: 0 };
      seen.count += 1;
      inodes.set(file.ino, seen);
    }
    let bytes = 0;
    for (const inode of inodes.values()) {
      if (inode.count >= inode.nlink) bytes += inode.size;
    }
    return bytes;
  }

  function liveWorkers() {
    const seen = new Set();
    for (const root of workers()) {
      for (const worker of root?.variantWorkers?.() || [root]) {
        if (worker) seen.add(worker);
      }
    }
    return [...seen];
  }

  // A loaded manifest means this process has served, prefetched or generated
  // the chapter since it started, including continuous-stream chapter
  // transitions that never hit a per-chapter route.
  function chapterLoaded(group) {
    return liveWorkers().some(worker => {
      try {
        return Boolean(worker.getChapterManifest?.(group.bookId, group.chapterIndex));
      } catch {
        // An id that fails path validation has no manifest in any worker.
        return false;
      }
    });
  }

  async function evictGroup(group) {
    await Promise.all(group.files.map(file => fsp.unlink(file.path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
    if (group.artifactDir) await fsp.rm(group.artifactDir, { recursive: true, force: true });
    // A request may have rebuilt a manifest from these files while they were
    // being removed. Workers drop or downgrade any chunk whose file is gone.
    await Promise.all(liveWorkers().map(async worker => {
      try {
        await worker.releaseEvictedChapter?.(group.bookId, group.chapterIndex);
      } catch {}
    }));
  }

  async function sweepNow({ reason = 'scheduled' } = {}) {
    const space = await diskSpace();
    if (space.available >= space.lowWater) return { evictedChapters: 0, freedBytes: 0, ...space };
    const needed = space.highWater - space.available;
    const groups = await scan();
    for (const group of groups) {
      if (chapterLoaded(group)) {
        recordUse(group.bookId, group.chapterIndex);
        group.lastUsedMs = now();
      }
    }
    const cutoff = now() - protectMs;
    const candidates = groups
      .filter(group => group.lastUsedMs < cutoff)
      .sort((left, right) => left.lastUsedMs - right.lastUsedMs);
    let freedBytes = 0;
    let evictedChapters = 0;
    for (const group of candidates) {
      if (freedBytes >= needed) break;
      // Re-check: a request may have loaded the chapter during the sweep.
      if (chapterLoaded(group)) continue;
      const bytes = reclaimableBytes(group);
      try {
        await evictGroup(group);
      } catch (error) {
        log.warn?.(`[audio-cache] Could not evict ${group.bookId} chapter ${group.chapterIndex}: ${error.message}`);
        continue;
      }
      usage.delete(usageKey(group.bookId, group.chapterIndex));
      usageDirty = true;
      freedBytes += bytes;
      evictedChapters += 1;
    }
    await flushUsage();
    const after = await diskSpace();
    const message = `[audio-cache] ${reason}: evicted ${evictedChapters} chapter(s), ` +
      `freed ${formatBytes(freedBytes)}; ${formatBytes(after.available)} free (target ${formatBytes(space.highWater)})`;
    if (after.available < after.lowWater) log.warn?.(`${message}. Free space is still below the floor.`);
    else log.log?.(message);
    return { evictedChapters, freedBytes, ...after };
  }

  function sweep(options) {
    if (!running) {
      running = sweepNow(options).finally(() => { running = null; });
    }
    return running;
  }

  // Imports call this first. It reclaims cache space when needed and refuses
  // the write only when the disk stays below the hard floor.
  async function ensureWritableSpace() {
    let space = await diskSpace();
    if (space.available < space.lowWater) {
      await sweep({ reason: 'write admission' }).catch(error => {
        log.warn?.(`[audio-cache] Sweep failed: ${error.message}`);
      });
      space = await diskSpace();
    }
    if (space.available < hardFloorBytes) {
      log.warn?.(`[audio-cache] Refusing write: ${formatBytes(space.available)} free, floor ${formatBytes(hardFloorBytes)}`);
      throw insufficientStorageError();
    }
    return space;
  }

  function start() {
    if (timer) return;
    const run = () => sweep()
      .then(flushUsage)
      .catch(error => log.warn?.(`[audio-cache] Sweep failed: ${error.message}`));
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    setTimeout(run, 30 * 1000).unref?.();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await flushUsage();
  }

  return { diskSpace, scan, sweep, ensureWritableSpace, recordUse, flushUsage, start, stop, reclaimableBytes };
}

module.exports = {
  createAudioCacheBudget,
  insufficientStorageError,
  TOP_LEVEL_AUDIO
};
