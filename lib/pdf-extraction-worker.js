// Runs one untrusted JavaScript PDF parse -- the pdfjs outline read or the
// pdf-parse text pass -- in an isolated worker thread. A crafted file that
// loops or grows without bound cannot be interrupted from the same thread,
// only by terminating this one. Each parse gets its own thread: pdf-parse
// bundles pdfjs 5, and the outline reader's pdfjs 6 leaves a fake worker on
// globalThis that makes a later pdf-parse in the same thread fail its API
// version check. See lib/pdf-extraction.js (startPdfParseWorker).
const { parentPort, workerData } = require('worker_threads');
const { __internal } = require('./pdf-extraction');

const PARSES = {
  outline: pdfPath => __internal.readPdfOutline(pdfPath),
  text: pdfPath => __internal.readPdfParseText(pdfPath)
};

(async () => {
  const { pdfPath, kind } = workerData;
  try {
    parentPort.postMessage({ kind, ok: true, result: await PARSES[kind](pdfPath) });
  } catch (err) {
    parentPort.postMessage({ kind, ok: false, error: (err && err.message) || String(err) });
  }
})();
