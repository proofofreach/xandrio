// Worker-thread entry for chunk planning. Each message is one plan request;
// the reply carries the same `id` so lib/chunk-plan-pool.js can match it.
// Planning is pure CPU work, so the worker never touches disk or network.
const { parentPort } = require('worker_threads');
const { planSplitChunks } = require('./chunk-planner');

parentPort.on('message', message => {
  const { id, text, maxChars, splitPolicy, engineLimits } = message || {};
  try {
    parentPort.postMessage({ id, ok: true, chunks: planSplitChunks(text, maxChars, splitPolicy, engineLimits) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: (error && error.message) || String(error) });
  }
});
