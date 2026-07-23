/**
 * Anna's Archive configuration route tests.
 *
 * Run: node test/test-annas-routes.js
 */

const express = require('express');
const http = require('http');
const { registerPreferencesRoutes } = require('../lib/routes/preferences-routes');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

async function withServer(fn) {
  let config = { secretKey: '', baseUrl: 'https://annas-archive.li', keySource: null, updatedAt: null };
  let saves = 0;
  const app = express();
  app.use(express.json());
  registerPreferencesRoutes(app, {
    annasAuthFile: `/tmp/xandrio-annas-route-${process.pid}.json`,
    availableVoices: [],
    cacheDir: '/tmp',
    customVoiceDir: '/tmp',
    customVoicesFile: '/tmp/unused-custom-voices.json',
    defaultVoice: 'edge:default',
    getAnnasConfig: () => ({ ...config }),
    gutenberg: { isEnabled: () => false, setEnabled: async () => {} },
    loadJSON: async () => ({}),
    saveJSON: async (_path, value) => {
      saves++;
      config = { ...value, keySource: 'settings' };
    },
    settingsFile: '/tmp/unused-settings.json',
    updateSettingsCache: () => {},
    validateAnnasOrigin: async () => 'https://annas-archive.li',
    voiceSamplesDir: '/tmp',
    zlibrary: {
      connect: async () => ({}), disconnect: async () => ({}), getStatus: async () => ({}), hasStoredSession: () => false
    }
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, {
      getConfig: () => ({ ...config }),
      getSaves: () => saves,
      setConfig: value => { config = { ...value }; }
    });
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
  return { status: response.status, text: await response.text() };
}

(async () => {
  console.log('\n━━━ Anna configuration routes ━━━');

  await withServer(async (base, state) => {
    const first = await request(base, 'POST', '/api/annas/configure', {
      secretKey: '  first-key  ', baseUrl: 'annas-archive.li'
    });
    const firstBody = JSON.parse(first.text);
    assert(first.status === 200 && firstBody.success && firstBody.replaced === false,
      'initial configuration is identified without returning the key');
    assert(state.getConfig().secretKey === 'first-key' && !first.text.includes('first-key'),
      'the key is trimmed for storage and redacted from the response');
    assert(Boolean(state.getConfig().updatedAt), 'configuration records a non-secret update time');

    const second = await request(base, 'POST', '/api/annas/configure', {
      secretKey: 'replacement-key', baseUrl: 'annas-archive.li'
    });
    const secondBody = JSON.parse(second.text);
    assert(second.status === 200 && secondBody.replaced === true,
      'a later save is explicitly identified as key replacement');
    assert(state.getConfig().secretKey === 'replacement-key' && state.getSaves() === 2,
      'replacement overwrites the locally stored key exactly once');

    const status = await request(base, 'GET', '/api/annas/status');
    const statusBody = JSON.parse(status.text);
    assert(statusBody.hasKey === true && statusBody.keySource === 'settings' && !status.text.includes('replacement-key'),
      'status reports key provenance without exposing the key');

    const beforeInvalid = state.getSaves();
    const invalid = await request(base, 'POST', '/api/annas/configure', {
      secretKey: 'key\nwith-control-character', baseUrl: 'annas-archive.li'
    });
    assert(invalid.status === 400 && state.getSaves() === beforeInvalid,
      'invalid replacement keys are rejected without changing configuration');

    state.setConfig({
      secretKey: 'environment-key', baseUrl: 'https://annas-archive.li', keySource: 'environment', updatedAt: null
    });
    const beforeEnvironmentWrite = state.getSaves();
    const environmentReplace = await request(base, 'POST', '/api/annas/configure', {
      secretKey: 'local-shadow-key', baseUrl: 'annas-archive.li'
    });
    const environmentReplaceBody = JSON.parse(environmentReplace.text);
    assert(environmentReplace.status === 409 && environmentReplaceBody.code === 'ANNAS_KEY_ENVIRONMENT_MANAGED' && state.getSaves() === beforeEnvironmentWrite,
      'an environment-managed key cannot be silently shadowed by local settings');

    const removed = await request(base, 'DELETE', '/api/annas/configure');
    const removedBody = JSON.parse(removed.text);
    assert(removed.status === 409 && removedBody.configured === true && removedBody.keySource === 'environment' && !removed.text.includes('environment-key'),
      'removal refuses to claim an environment-managed key was disconnected');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
