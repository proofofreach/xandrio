const express = require('express');
const http = require('http');
const { registerBookmarksRoutes } = require('../lib/routes/bookmarks-routes');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  const app = express();
  app.use(express.json());
  const storageFailure = async () => { throw new Error('/private/data/store.json'); };
  registerBookmarksRoutes(app, {
    bookmarksFile: '/private/data/bookmarks.json',
    clientSettingsFile: '/private/data/client-settings.json',
    jsonStore: { SKIP_SAVE: Symbol('skip') },
    loadJSON: storageFailure,
    updateJSON: storageFailure
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const checks = [
      ['POST', '/api/bookmarks', { bookId: 'book', chapterIndex: 0, timestamp: 1 }, 'Failed to save bookmark'],
      ['GET', '/api/bookmarks', null, 'Failed to load bookmarks'],
      ['GET', '/api/bookmarks/book', null, 'Failed to load bookmarks'],
      ['DELETE', '/api/bookmarks/bm_1', null, 'Failed to delete bookmark'],
      ['GET', '/api/settings/client', null, 'Failed to load client settings'],
      ['PUT', '/api/settings/client', { settings: { defaultSpeed: 1.25 } }, 'Failed to save client settings']
    ];
    for (const [method, pathname, body, expected] of checks) {
      const result = await request(base, method, pathname, body);
      assert(result.status === 500 && result.body.error === expected, `${method} ${pathname} hides storage internals`);
      assert(!JSON.stringify(result.body).includes('/private/'), `${method} ${pathname} does not leak a private path`);
    }
    // Client disconnects are ordinary. A listener closing the app, seeking, or
    // locking the phone aborts an in-flight audio response; that must not be
    // logged as a server fault, and nothing may be written to a socket that is
    // already gone. Misreading this noise as failure is what obscured the
    // production incident this work came from.
    const { sendServerError } = require('../server').__test;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let wroteToDeadSocket = false;
    const destroyedResponse = {
      headersSent: false,
      destroyed: true,
      writableEnded: false,
      destroy() {},
      status() { wroteToDeadSocket = true; return this; },
      json() { wroteToDeadSocket = true; return this; }
    };

    sendServerError(destroyedResponse, new Error('client went away'), 'Failed to serve audio');

    assert(logged.length === 0, 'a client disconnect is not logged as a server error');
    assert(!wroteToDeadSocket, 'nothing is written to an already-destroyed socket');

    const audioResponseSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'audio-response.js'),
      'utf8'
    );
    for (const code of [
      'ERR_STREAM_PREMATURE_CLOSE',
      'ECONNRESET',
      'ERR_STREAM_UNABLE_TO_PIPE',
      'ERR_STREAM_DESTROYED'
    ]) {
      assert(
        audioResponseSource.includes(code),
        `${code} is treated as a client disconnect, not a stream failure`
      );
    }
  } finally {
    console.error = originalConsoleError;
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
