// Runs a single Kindle (MOBI/AZW3) extraction attempt in an isolated
// worker thread. The pinned @lingo-reader/mobi-parser dependency is fully
// synchronous (readFileSync-based decompression), so a hostile file that
// triggers unbounded output growth or an infinite loop cannot be
// interrupted from the same thread — only killing the thread from the
// outside works. See lib/kindle-extraction.js (runInKindleWorker) for the
// timeout/memory-limited caller.
const { parentPort, workerData } = require('worker_threads');
const { __internal } = require('./kindle-extraction');

(async () => {
  try {
    const { action, bookPath, sourceLabel, spec, options } = workerData;
    let result;
    if (action === 'metadata') {
      result = await __internal.attemptKindleMetadata(bookPath, spec, options || {});
    } else {
      result = await __internal.buildKindleExtractionCandidate(bookPath, sourceLabel, spec, options || {});
    }
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: (err && err.message) || String(err) });
  }
})();
