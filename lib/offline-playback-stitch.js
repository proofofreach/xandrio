'use strict';

// Offline packages encode straight from narration chunks, so offline
// preparation no longer leaves the stitched playback chapter file behind.
// Playback readiness, voice fallback and duration reporting still read that
// file. This queue rebuilds it after a package is published, one chapter at a
// time and off the narration pipeline: nothing waits on it, and a failure
// only leaves playback to stitch the chapter on demand as before.

function isAbort(error) {
  return error?.name === 'AbortError';
}

function createOfflinePlaybackStitcher({
  stitch,
  retain = () => () => {},
  onError = () => {}
} = {}) {
  if (typeof stitch !== 'function') throw new TypeError('Playback stitching requires a stitch function');
  const queue = [];
  const keys = new Set();
  let active = null;
  let idle = Promise.resolve();
  let settleIdle = null;

  function markBusy() {
    if (settleIdle) return;
    idle = new Promise(resolve => { settleIdle = resolve; });
  }

  function markIdleIfDone() {
    if (active || queue.length > 0 || !settleIdle) return;
    const resolve = settleIdle;
    settleIdle = null;
    resolve();
  }

  async function run(job) {
    // Chunks must survive eviction while ffmpeg reads them.
    const release = retain(job.bookId, job.chapterIndex);
    try {
      await stitch({ ...job, signal: job.controller.signal });
    } catch (error) {
      if (!isAbort(error) && !job.controller.signal.aborted) onError(error, job);
    } finally {
      release();
    }
  }

  function pump() {
    if (active) return;
    const job = queue.shift();
    if (!job) {
      markIdleIfDone();
      return;
    }
    active = job;
    run(job).finally(() => {
      keys.delete(job.key);
      active = null;
      pump();
    });
  }

  /**
   * Queue one chapter. Returns false when the same chapter is already queued
   * or running.
   */
  function schedule(job) {
    const key = String(job?.key || '');
    if (!key || keys.has(key)) return false;
    keys.add(key);
    markBusy();
    queue.push({ ...job, key, controller: new AbortController() });
    pump();
    return true;
  }

  /** Drop a title's queued chapters and abort its running stitch. */
  async function cancelBook(bookId) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].bookId !== bookId) continue;
      const [job] = queue.splice(index, 1);
      keys.delete(job.key);
    }
    const running = active;
    if (running?.bookId === bookId) {
      running.controller.abort();
      await waitForIdle(bookId);
    }
    markIdleIfDone();
  }

  /** Resolve once no stitch for the title (or for any title) is queued or running. */
  async function waitForIdle(bookId = null) {
    if (bookId === null) return idle;
    while ((active && active.bookId === bookId) || queue.some(job => job.bookId === bookId)) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  return { schedule, cancelBook, waitForIdle };
}

module.exports = { createOfflinePlaybackStitcher };
