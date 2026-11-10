'use strict';

// Covers are stored at whatever resolution the source offered, up to about
// 1600x2450. A browser holds an image decoded: 4 bytes a pixel, so one such
// cover costs about 16 MB, and the library shows dozens. On iOS that memory
// counts toward the limit at which the system kills the page.
//
// The UI never draws a cover larger than about 300 CSS pixels wide, so the
// served cover is a display copy no larger than 600x900 (2x for retina). It is
// made once with ffmpeg next to the original and remade when the original
// changes. Any failure serves the original: a large cover is better than none.

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

const DISPLAY_MAX_WIDTH = 600;
const DISPLAY_MAX_HEIGHT = 900;

function displayCoverPath(cacheDir, bookId) {
  return path.join(cacheDir, `${bookId}_cover_display.jpg`);
}

function defaultRun(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function needsDisplayCopy(dimensions, maxWidth = DISPLAY_MAX_WIDTH, maxHeight = DISPLAY_MAX_HEIGHT) {
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width > maxWidth || height > maxHeight;
}

function createCoverDisplay({
  cacheDir,
  run = defaultRun,
  maxWidth = DISPLAY_MAX_WIDTH,
  maxHeight = DISPLAY_MAX_HEIGHT,
  concurrency = 2,
  timeoutMs = 15000,
  log = message => console.warn(message)
} = {}) {
  if (!cacheDir) throw new TypeError('cacheDir is required');
  const inFlight = new Map();
  const waiters = [];
  let running = 0;

  async function withSlot(task) {
    if (running >= concurrency) await new Promise(resolve => waiters.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiters.shift()?.();
    }
  }

  async function freshCopy(bookId, sourcePath) {
    const target = displayCoverPath(cacheDir, bookId);
    const [source, existing] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(target).catch(() => null)
    ]);
    if (existing && existing.size > 0 && existing.mtimeMs >= source.mtimeMs) return target;
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await withSlot(() => run('ffmpeg', [
        '-v', 'error',
        '-i', sourcePath,
        '-vf', `scale=w='min(${maxWidth},iw)':h='min(${maxHeight},ih)':force_original_aspect_ratio=decrease`,
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'mjpeg',
        '-y', temporary
      ], { timeoutMs }));
      const written = await fs.stat(temporary);
      if (!written.size) throw new Error('empty display cover');
      await fs.rename(temporary, target);
      return target;
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  // Returns the cover to send: the display copy when the original is larger
  // than the display size, otherwise the original itself.
  async function displayCover({ bookId, sourcePath, cover }) {
    if (!cover?.buffer || !needsDisplayCopy(cover.dimensions, maxWidth, maxHeight)) return cover;
    try {
      let job = inFlight.get(bookId);
      if (!job) {
        job = freshCopy(bookId, sourcePath).finally(() => inFlight.delete(bookId));
        inFlight.set(bookId, job);
      }
      const target = await job;
      return { ...cover, buffer: await fs.readFile(target), contentType: 'image/jpeg', display: true };
    } catch (error) {
      log(`[cover] display copy failed for ${bookId}: ${error.message}`);
      return cover;
    }
  }

  return { displayCover };
}

module.exports = {
  DISPLAY_MAX_HEIGHT,
  DISPLAY_MAX_WIDTH,
  createCoverDisplay,
  displayCoverPath,
  needsDisplayCopy
};
