/**
 * Engine status route tests
 *
 * Run: node test/test-engine-status.js
 */

const express = require('express');
const http = require('http');
const { registerPreferencesRoutes, __test } = require('../lib/routes/preferences-routes');

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

async function withServer(options, fn) {
  const app = express();
  app.use(express.json());
  registerPreferencesRoutes(app, {
    annasAuthFile: '/tmp/unused-annas.json',
    availableVoices: [],
    cacheDir: '/tmp',
    dataDir: '/tmp',
    defaultVoice: 'edge:default',
    getAnnasConfig: () => ({}),
    gutenberg: { isEnabled: () => false, setEnabled: async () => {} },
    loadJSON: async () => ({}),
    saveJSON: async () => {},
    settingsFile: '/tmp/unused-settings.json',
    updateSettingsCache: () => {},
    voiceSamplesDir: '/tmp',
    zlibrary: {
      isConfigured: () => false,
      getProfile: async () => ({}),
      saveCredentials: async () => {}
    },
    ...options
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function getJson(base, path) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

async function postJson(base, path, payload) {
  const url = new URL(path, base);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function testChatterboxStatusStartsActiveVoice() {
  __test.resetEngineStatusCache();
  const originalFetch = global.fetch;
  let processRunning = false;
  let preparedVoice = null;
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8767');
  };

  try {
    await withServer({
      getCurrentVoice: () => 'chatterbox:brick-scott',
      getEngineProcessHints: () => ({ chatterbox: processRunning }),
      prepareVoiceProvider: (voiceId) => {
        preparedVoice = voiceId;
        processRunning = true;
      }
    }, async (base) => {
      const body = await getJson(base, '/api/engines/status');
      assertEqual(preparedVoice, 'chatterbox:brick-scott', 'status check requests active Chatterbox start');
      assertEqual(body.engines.chatterbox.process, true, 'status includes managed Chatterbox process hint');
      assertEqual(body.engines.chatterbox.status, 'starting', 'managed Chatterbox is starting, not offline');
      assertEqual(body.engines.chatterbox.error, 'Health check failed', 'engine status does not expose connection details');
    });
  } finally {
    global.fetch = originalFetch;
  }
}

async function testPreferenceFailuresHideInternalDetails() {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withServer({
      loadJSON: async () => { throw new Error('/private/data/settings.json'); }
    }, async (base) => {
      const body = await getJson(base, '/api/voices');
      assertEqual(body.error, 'Failed to load voices', 'preference route failures hide internal paths');
    });
  } finally {
    console.error = originalConsoleError;
  }
}

async function testOfflineStatusUsesShortCache() {
  __test.resetEngineStatusCache();
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let now = 100000;
  let chatterboxCalls = 0;
  Date.now = () => now;
  global.fetch = async (url) => {
    if (String(url).includes('8767')) {
      chatterboxCalls++;
      if (chatterboxCalls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:8767');
    }
    return {
      ok: true,
      json: async () => ({ ok: true, device: 'mlx', voices: ['brick-scott'] })
    };
  };

  try {
    await withServer({
      getEngineProcessHints: () => ({ chatterbox: false })
    }, async (base) => {
      const first = await getJson(base, '/api/engines/status');
      assertEqual(first.engines.chatterbox.status, 'offline', 'unmanaged failed health reports offline');

      now += 1000;
      const cached = await getJson(base, '/api/engines/status');
      assertEqual(cached.engines.chatterbox.status, 'offline', 'offline status is cached briefly');
      assertEqual(chatterboxCalls, 1, 'offline cache prevents immediate repeated Chatterbox probe');

      now += 1500;
      const recovered = await getJson(base, '/api/engines/status');
      assertEqual(recovered.engines.chatterbox.status, 'online', 'offline cache expires quickly and observes recovery');
      assertEqual(chatterboxCalls, 2, 'expired cache rechecks Chatterbox');
    });
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
}

async function testVoiceSelectionInvalidatesEngineStatusCache() {
  __test.resetEngineStatusCache();
  const originalFetch = global.fetch;
  let healthCalls = 0;
  let selectedVoice = null;
  let processRunning = false;
  global.fetch = async (url) => {
    if (String(url).includes('8767')) {
      healthCalls++;
      if (!processRunning) throw new Error('connect ECONNREFUSED 127.0.0.1:8767');
    }
    return {
      ok: true,
      json: async () => ({ ok: true, device: 'mlx', voices: ['brick-scott'] })
    };
  };

  try {
    await withServer({
      availableVoices: [{ id: 'chatterbox:brick-scott' }],
      getEngineProcessHints: () => ({ chatterbox: processRunning }),
      loadJSON: async () => ({}),
      saveJSON: async () => {},
      updateSettingsCache: () => {},
      onVoiceSelected: (voiceId) => {
        selectedVoice = voiceId;
        processRunning = true;
      }
    }, async (base) => {
      const down = await getJson(base, '/api/engines/status');
      assertEqual(down.engines.chatterbox.status, 'offline', 'initial status can cache Chatterbox offline');

      const selected = await postJson(base, '/api/voice', { voiceId: 'chatterbox:brick-scott' });
      assertEqual(selected.success, true, 'Chatterbox voice selection succeeds while engine is down');
      assertEqual(selectedVoice, 'chatterbox:brick-scott', 'voice selection requests Chatterbox start');

      const recovered = await getJson(base, '/api/engines/status');
      assertEqual(recovered.engines.chatterbox.status, 'online', 'voice selection clears stale offline status');
      assertEqual(healthCalls, 2, 'status rechecks Chatterbox after selection');
    });
  } finally {
    global.fetch = originalFetch;
  }
}

(async () => {
  console.log('\n━━━ Engine status ━━━');
  await testChatterboxStatusStartsActiveVoice();
  await testOfflineStatusUsesShortCache();
  await testVoiceSelectionInvalidatesEngineStatusCache();
  await testPreferenceFailuresHideInternalDetails();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
