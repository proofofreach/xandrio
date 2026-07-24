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

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-voice-authority-'));
  const voicesFile = path.join(root, 'voices.json');
  let registry = { voices: [] };
  const app = express();
  registerPreferencesRoutes(app, {
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
    settingsFile: path.join(root, 'settings.json'),
    updateSettingsCache: () => {},
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
    const voicePath = path.join(root, 'authorized-voice.wav');
    assert(((await fs.stat(voicePath)).mode & 0o777) === 0o600,
      'stored voice references are readable and writable only by the server account');
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
