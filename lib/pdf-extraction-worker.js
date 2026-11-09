// Runs the untrusted JavaScript PDF parses -- the pdfjs outline read, then the
// pdf-parse text pass -- in an isolated worker thread. A crafted file that
// loops or grows without bound cannot be interrupted from the same thread,
// only by terminating this one. Each result is posted as soon as it exists so
// the outline does not wait for the text pass. See lib/pdf-extraction.js
// (startPdfParseWorker) for the timeout/memory-limited caller and for why the
// two parses share this thread in this order.
const { parentPort, workerData } = require('worker_threads');
const { __internal } = require('./pdf-extraction');

(async () => {
  const { pdfPath } = workerData;
  for (const [kind, parse] of [
    ['outline', () => __internal.readPdfOutline(pdfPath)],
    ['text', () => __internal.readPdfParseText(pdfPath)]
  ]) {
    try {
      parentPort.postMessage({ kind, ok: true, result: await parse() });
    } catch (err) {
      parentPort.postMessage({ kind, ok: false, error: (err && err.message) || String(err) });
    }
  }
})();
