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
