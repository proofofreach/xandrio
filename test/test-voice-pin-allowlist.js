/**
 * A playback request's `?voiceId=` pin must respect the instance's voice
 * provider allowlist (XANDRIO_VOICE_PROVIDERS), as every other voice
 * selection does. It used to be checked against the full voice registry, so
 * a pin could generate audio with a provider the operator had disabled.
 * A book's saved narrator, and the global voice, obey the allowlist too: an
 * excluded provider's pin is ignored, then deleted at startup.
 *
 * Run: node test/test-voice-pin-allowlist.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-pin-allowlist-'));
const data = path.join(root, 'data');
const cache = path.join(root, 'cache');
fs.mkdirSync(data);
fs.mkdirSync(cache);
process.env.DATA_DIR = data;
process.env.CACHE_DIR = cache;
process.env.XANDRIO_TOKEN = 'voice-pin-allowlist-token';
process.env.XANDRIO_VOICE_PROVIDERS = 'kokoro';
process.env.KOKORO_AUTO_START = 'false';
process.env.CHATTERBOX_AUTO_START = 'false';
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  voice: 'kokoro:am_onyx',
  // A book whose saved narrator belongs to a since-disabled provider.
  bookNarration: {
    'edge-book': { voiceId: 'en-US-AndrewMultilingualNeural', fallbackPolicy: 'wait' },
    'kokoro-pinned': { voiceId: 'kokoro:af_heart', fallbackPolicy: 'wait' }
  }
}));

const { resolveNarrationContext, dropExcludedBookPins, getActiveVoice } = require('../server').__test;

async function statusOf(promise) {
  try {
    await promise;
    return 200;
  } catch (error) {
    return error.statusCode || 500;
  }
}

(async () => {
  assert.equal(await statusOf(resolveNarrationContext('kokoro-book', 0, { voiceId: 'en-US-AndrewMultilingualNeural' })), 400,
    'a pin naming a voice from a disabled provider is refused');
  console.log('  ✓ a pin naming a voice from a disabled provider is refused');
  assert.equal(await statusOf(resolveNarrationContext('kokoro-book', 0, { voiceId: 'no-such-voice' })), 400);
  console.log('  ✓ a pin naming an unknown voice is refused');
  assert.equal(await statusOf(resolveNarrationContext('kokoro-book', 0, { voiceId: ['kokoro:am_onyx'] })), 400);
  console.log('  ✓ a repeated voiceId query parameter is refused');
  const allowed = await resolveNarrationContext('kokoro-book', 0, { voiceId: 'kokoro:am_onyx' });
  assert.equal(allowed.actualVoiceId, 'kokoro:am_onyx');
  console.log('  ✓ a pin naming an allowlisted voice resolves');
  const own = await resolveNarrationContext('edge-book', 0);
  assert.equal(own.actualVoiceId, 'kokoro:am_onyx');
  console.log("  ✓ a book pinned to an excluded provider inherits the global narrator");
  assert.equal(await statusOf(resolveNarrationContext('edge-book', 0, { voiceId: 'en-US-AndrewMultilingualNeural' })), 400);
  console.log("  ✓ the excluded saved narrator cannot be requested by voiceId");
  assert.equal(getActiveVoice('kokoro-pinned'), 'kokoro:af_heart');
  console.log('  ✓ an allowlisted book pin still applies');
  assert.equal(await dropExcludedBookPins(), 1);
  const stored = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.bookNarration), ['kokoro-pinned']);
  assert.equal(await dropExcludedBookPins(), 0);
  console.log('  ✓ the startup sweep deletes only excluded pins and is idempotent');
  const settingsPath = path.join(data, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ ...stored, voice: 'en-US-AndrewMultilingualNeural' }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(settingsPath, later, later);
  await require('../server').__test.refreshSettingsSnapshots?.();
  assert.notEqual(getActiveVoice('unpinned-book'), 'en-US-AndrewMultilingualNeural');
  console.log('  ✓ a global voice from an excluded provider is not served');
  console.log('voice pin allowlist: 9 passed, 0 failed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
