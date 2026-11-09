#!/usr/bin/env node
'use strict';
// The offline position queue retries a failed POST on the next flush. A
// position the server rejects as invalid must leave the queue, or it is
// resent on every flush for as long as the device keeps it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'offline.js'), 'utf8');
const start = source.indexOf('function pendingPositionsKey(');
assert(start >= 0, 'Missing pendingPositionsKey');
const code = [
  source.match(/^const PERMANENT_POSITION_REJECTIONS = .*$/m)[0],
  'const pendingPositionFlushes = new Map();',
  'const pendingPositionFlushControllers = new Map();',
  "const PENDING_POSITIONS_KEY = 'pending';",
  source.slice(start).replaceAll('export ', '')
].join('\n');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (error) { failed++; console.log(`  ❌ ${name}: ${error.message}`); }
}

function harness(statusFor) {
  const store = new Map();
  const sent = [];
  const context = {
    navigator: { onLine: true },
    globalThis: { crypto: { randomUUID: () => Math.random().toString(36).slice(2) } },
    AbortController,
    localStorage: { removeItem: key => store.delete(key) },
    offlineScopeId: () => 'user-a',
    readJSON: (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    writeJSON: (key, value) => { store.set(key, structuredClone(value)); return true; },
    async apiSend(method, url, payload) {
      sent.push(payload.chapterIndex);
      const status = statusFor(payload);
      if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
      return {};
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, sent, queue: () => store.get('pending:user-a') || [] };
}

(async () => {
  console.log('\n🧪 Pending position flush');

  await check('a position the server rejects with 400 leaves the queue; others stay', async () => {
    const h = harness(payload => (payload.chapterIndex === 999 ? 400 : payload.chapterIndex === 2 ? 503 : 0));
    h.context.queuePendingPosition({ bookId: 'b', chapterIndex: 999, timestamp: 1 });
    h.context.queuePendingPosition({ bookId: 'b', chapterIndex: 2, timestamp: 1 });
    h.context.queuePendingPosition({ bookId: 'b', chapterIndex: 3, timestamp: 1 });
    await h.context.flushPendingPositions();
    assert.deepEqual(h.queue().map(item => item.chapterIndex), [2]);
    await h.context.flushPendingPositions();
    assert.deepEqual(h.sent, [999, 2, 3, 2], 'the rejected position is not resent');
  });

  await check('a position for a book the server no longer has (404) leaves the queue', async () => {
    const h = harness(() => 404);
    h.context.queuePendingPosition({ bookId: 'gone', chapterIndex: 0, timestamp: 1 });
    await h.context.flushPendingPositions();
    assert.equal(h.queue().length, 0);
  });

  await check('network and server errors keep the position for a later retry', async () => {
    const h = harness(() => 500);
    h.context.queuePendingPosition({ bookId: 'b', chapterIndex: 0, timestamp: 1 });
    await h.context.flushPendingPositions();
    assert.equal(h.queue().length, 1);
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
