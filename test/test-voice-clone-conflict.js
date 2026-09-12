'use strict';

// Regression tests for the voice-clone duplicate-name 409s.
// A refactor migration once shadowed the imported `conflict` helper with a
// `let conflict` flag in POST /api/voices/clone, turning both intended 409s
// into 500s (TDZ at the pre-check, Boolean-call at the registry race check).

const assert = require('node:assert');
const express = require('express');
const fs = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { registerPreferencesRoutes } = require('../lib/routes/preferences-routes');
const defaultJsonStore = require('../lib/json-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`); console.error(`    ${error.stack || error.message}`); }
}

function wavBuffer() {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]);
}

function multipartBody(boundary, fields, file) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="ref.wav"\r\n` +
    'Content-Type: audio/wav\r\n\r\n'
  ));
  parts.push(file);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

async function postClone(base, body, boundary) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/voices/clone`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withCloneServer({ registryForReads, registryForUpdate }, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-409-'));
  const app = express();
  registerPreferencesRoutes(app, {
    chatterboxVoicesEnabled: true,
    customVoicesFile: path.join(dir, 'voices.json'),
    customVoiceDir: path.join(dir, 'voices'),
    jsonStore: {
      SKIP_SAVE: defaultJsonStore.SKIP_SAVE,
      update: async (_file, updater) => updater({ voices: registryForUpdate })
    },
    loadJSON: async () => ({ voices: registryForReads }),
    requireAdmin: (_req, _res, next) => next()
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  const boundary = 'testboundary409';
  const fields = { name: 'Test Voice', authorityConfirmed: 'true' };

  await test('pre-check duplicate returns 409 (not 500)', async () => {
    const existing = [{ id: 'test-voice', ext: 'wav' }];
    await withCloneServer({ registryForReads: existing, registryForUpdate: existing }, async base => {
      const res = await postClone(base, multipartBody(boundary, fields, wavBuffer()), boundary);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'A custom voice with that name already exists.');
    });
  });

  await test('registry-race duplicate returns 409 (not 500)', async () => {
    // Reads see no conflict; the locked update observes a concurrent insert.
    const raced = [{ id: 'test-voice', ext: 'wav' }];
    await withCloneServer({ registryForReads: [], registryForUpdate: raced }, async base => {
      const res = await postClone(base, multipartBody(boundary, fields, wavBuffer()), boundary);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, 'A custom voice with that name already exists.');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
