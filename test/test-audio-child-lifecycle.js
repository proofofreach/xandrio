const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForChild } = require('../lib/chapter-audio-stream');
function child() {
  const process = new EventEmitter();
  process.stdin = new EventEmitter();
  process.exitCode = null;
  process.signalCode = null;
  process.kill = signal => { process.signalCode = signal; };
  return process;
}
(async () => {
  const active = child();
  const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const result = waitForChild(active, 'encoder', () => '', new AbortController().signal);
  const rejected = assert.rejects(result, error => error === brokenPipe);
  active.stdin.emit('error', brokenPipe);
  await rejected;
  assert.equal(active.signalCode, 'SIGKILL');
  // A second queued error after disposal must not become an uncaught event.
  active.stdin.emit('error', brokenPipe);
  const controller = new AbortController();
  const cancelled = child();
  const cancellation = waitForChild(cancelled, 'encoder', () => '', controller.signal);
  const aborted = assert.rejects(cancellation, error => error.name === 'AbortError');
  controller.abort();
  cancelled.stdin.emit('error', brokenPipe);
  await aborted;
  const completed = child();
  const completion = waitForChild(completed, 'encoder', () => '');
  completed.exitCode = 0;
  completed.emit('close', 0, null);
  await completion;
  completed.stdin.emit('error', brokenPipe);
  assert.equal(completed.signalCode, null);
  console.log('3 passed, 0 failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
