/**
 * Z-Library preferences route tests.
 *
 * Run: node test/test-zlibrary-routes.js
 */

const express = require('express');
const http = require('http');
const { registerPreferencesRoutes } = require('../lib/routes/preferences-routes');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function createClient(overrides = {}) {
  return {
    hasStoredSession: () => false,
    connect: async () => ({ configured: true, state: 'connected', reachable: true, authenticated: true }),
    disconnect: async () => ({ configured: false, state: 'disconnected', reachable: false, authenticated: false }),
    getStatus: async () => ({ configured: false, state: 'disconnected', reachable: false, authenticated: false }),
    search: async () => [],
    download: async () => {},
    ...overrides
  };
}

async function withServer(zlibrary, fn) {
  const app = express();
  app.use(express.json());
  registerPreferencesRoutes(app, {
    annasAuthFile: '/tmp/unused-annas.json',
    availableVoices: [],
    cacheDir: '/tmp',
    customVoiceDir: '/tmp',
    customVoicesFile: '/tmp/unused-custom-voices.json',
    defaultVoice: 'edge:default',
    getAnnasConfig: () => ({}),
    gutenberg: { isEnabled: () => false, setEnabled: async () => {} },
    loadJSON: async () => ({}),
    saveJSON: async () => {},
    settingsFile: '/tmp/unused-settings.json',
    updateSettingsCache: () => {},
    voiceSamplesDir: '/tmp',
    zlibrary
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
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

async function testConfigureDelegatesAndReturnsValidatedStatus() {
  let received = null;
  const connected = { configured: true, state: 'connected', reachable: true, authenticated: true, downloadsRemaining: 8 };
  await withServer(createClient({
    connect: async credentials => {
      received = credentials;
      return connected;
    }
  }), async base => {
    const result = await request(base, 'POST', '/api/zlibrary/configure', {
      email: 'reader@example.test',
      password: 'not-persisted'
    });
    assertEqual(result.status, 200, 'configure succeeds with a connected client');
    assertDeepEqual(received, { email: 'reader@example.test', password: 'not-persisted' }, 'configure delegates credentials to connect');
    assertDeepEqual(result.body, { success: true, ...connected }, 'configure returns the validated client status');
  });
}

async function testStatusDelegatesWithoutInventingQuota() {
  const unavailable = {
    configured: true,
    state: 'unavailable',
    reachable: false,
    authenticated: false,
    errorCode: 'ZLIB_TIMEOUT',
    message: 'Z-Library is temporarily unavailable.'
  };
  await withServer(createClient({ getStatus: async () => unavailable }), async base => {
    const result = await request(base, 'GET', '/api/zlibrary/status');
    assertEqual(result.status, 200, 'status remains a successful route response');
    assertDeepEqual(result.body, unavailable, 'status returns the client state unchanged');
    assertEqual(Object.hasOwn(result.body, 'downloadsToday'), false, 'status does not invent quota fields');
  });
}

async function testDisconnectDelegatesToClient() {
  let disconnectCalls = 0;
  const disconnected = { configured: false, state: 'disconnected', reachable: false, authenticated: false };
  await withServer(createClient({
    disconnect: async () => {
      disconnectCalls++;
      return disconnected;
    }
  }), async base => {
    const result = await request(base, 'DELETE', '/api/zlibrary/configure');
    assertEqual(result.status, 200, 'disconnect succeeds');
    assertEqual(disconnectCalls, 1, 'disconnect delegates exactly once to the client');
    assertDeepEqual(result.body, { success: true, ...disconnected }, 'disconnect returns the disconnected status');
  });
}

async function testTypedErrorsMapToSafeHttpResponses() {
  const cases = [
    ['ZLIB_AUTH_INVALID', 401, 'The Z-Library credentials were rejected.'],
    ['ZLIB_TIMEOUT', 504, 'Z-Library did not respond in time.'],
    ['ZLIB_UNAVAILABLE', 503, 'Z-Library is temporarily unavailable.']
  ];
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const [code, expectedStatus, publicMessage] of cases) {
      await withServer(createClient({
        connect: async () => {
          const error = new Error('upstream response included token=secret');
          error.code = code;
          error.statusCode = 599;
          error.publicMessage = publicMessage;
          throw error;
        }
      }), async base => {
        const result = await request(base, 'POST', '/api/zlibrary/configure', {
          email: 'reader@example.test',
          password: 'not-persisted'
        });
        assertEqual(result.status, expectedStatus, `${code} maps to the correct HTTP status`);
        assertEqual(result.body.error, publicMessage, `${code} returns the safe public message`);
        assertEqual(result.body.code, code, `${code} returns the stable diagnostic code`);
        assertEqual(JSON.stringify(result.body).includes('token=secret'), false, `${code} does not expose upstream details`);
      });
    }
  } finally {
    console.error = originalConsoleError;
  }
}

(async () => {
  console.log('\n━━━ Z-Library routes ━━━');
  await testConfigureDelegatesAndReturnsValidatedStatus();
  await testStatusDelegatesWithoutInventingQuota();
  await testDisconnectDelegatesToClient();
  await testTypedErrorsMapToSafeHttpResponses();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
