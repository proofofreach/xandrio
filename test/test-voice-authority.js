const express = require('express');
const http = require('http');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { registerPreferencesRoutes } = require('../lib/routes/preferences-routes');

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

function voiceForm({ confirmed = false, name = 'authorized-voice' } = {}) {
  const body = new FormData();
  body.append('name', name);
  body.append('audio', new Blob([Buffer.from('RIFF0000WAVE', 'ascii')], { type: 'audio/wav' }), 'sample.wav');
  if (confirmed) body.append('authorityConfirmed', 'true');
  return body;
}

const skipSave = Symbol('SKIP_SAVE');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-voice-authority-'));
  const voicesFile = path.join(root, 'voices.json');
  let registry = { voices: [] };
  let customVoiceSnapshot = null;
  const app = express();
  // Voice cloning writes to the server-wide voice registry, so the route is
  // admin-only in production. This suite covers the authority/consent contract
  // and on-disk permissions, so the guard is stubbed out here; the guard itself
  // is asserted separately below against the real default.
  registerPreferencesRoutes(app, {
    requireAdmin: (_req, _res, next) => next(),
    annasAuthFile: path.join(root, 'annas.json'),
    availableVoices: [],
    cacheDir: root,
    customVoicesFile: voicesFile,
    customVoiceDir: root,
    defaultVoice: 'edge:default',
    getAnnasConfig: () => ({}),
    gutenberg: { isEnabled: () => false, setEnabled: async () => {} },
    loadJSON: async file => file === voicesFile ? registry : {},
    saveJSON: async (file, value) => { if (file === voicesFile) registry = value; },
    jsonStore: {
      SKIP_SAVE: skipSave,
      update: async (file, mutate, fallback) => {
        const current = file === voicesFile ? registry : { ...fallback };
        const next = await mutate(current);
        if (next === skipSave) return current;
        if (file === voicesFile) registry = next;
        return next;
      }
    },
    settingsFile: path.join(root, 'settings.json'),
    updateSettingsCache: () => {},
    updateCustomVoiceRegistry: value => { customVoiceSnapshot = value; },
    voiceSamplesDir: root,
    zlibrary: {
      connect: async () => ({}),
      disconnect: async () => ({}),
      getStatus: async () => ({ configured: false })
    }
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rejected = await fetch(`${base}/api/voices/clone`, { method: 'POST', body: voiceForm() });
    const rejectedBody = await rejected.json();
    assert(rejected.status === 400 && rejectedBody.code === 'VOICE_AUTHORITY_CONFIRMATION_REQUIRED',
      'voice reference uploads require explicit authority and consent confirmation');
    assert(registry.voices.length === 0, 'an unconfirmed voice reference is not stored');

    const accepted = await fetch(`${base}/api/voices/clone`, {
      method: 'POST',
      body: voiceForm({ confirmed: true })
    });
    assert(accepted.status === 201, 'a confirmed voice reference remains fully supported');
    assert(registry.voices.length === 1, 'the confirmed custom voice is registered');
    assert(customVoiceSnapshot === registry,
      'the custom-voice write updates the injected in-memory snapshot');
    const voicePath = path.join(root, 'authorized-voice.wav');
    assert(((await fs.stat(voicePath)).mode & 0o777) === 0o600,
      'stored voice references are readable and writable only by the server account');

    const guarded = express();
    registerPreferencesRoutes(guarded, {
      annasAuthFile: path.join(root, 'annas.json'),
      availableVoices: [],
      cacheDir: root,
      customVoicesFile: voicesFile,
      customVoiceDir: root,
      defaultVoice: 'edge:default',
      getAnnasConfig: () => ({}),
      gutenberg: { isEnabled: () => false, setEnabled: async () => {} },
      loadJSON: async () => ({}),
      saveJSON: async () => {},
      settingsFile: path.join(root, 'settings.json'),
      updateSettingsCache: () => {},
      voiceSamplesDir: root,
      zlibrary: {
        connect: async () => ({}),
        disconnect: async () => ({}),
        getStatus: async () => ({ configured: false })
      }
    });
    const guardedServer = http.createServer(guarded);
    await new Promise(resolve => guardedServer.listen(0, '127.0.0.1', resolve));
    const guardedBase = `http://127.0.0.1:${guardedServer.address().port}`;
    try {
      const unauthenticated = await fetch(`${guardedBase}/api/voices/clone`, {
        method: 'POST',
        body: voiceForm({ confirmed: true, name: 'unauthenticated-voice' })
      });
      assert(unauthenticated.status === 403,
        'the default guard refuses voice cloning without an admin session');
      const removal = await fetch(`${guardedBase}/api/voices/clone/anything`, { method: 'DELETE' });
      assert(removal.status === 403,
        'the default guard refuses voice removal without an admin session');
    } finally {
      await new Promise(resolve => guardedServer.close(resolve));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
