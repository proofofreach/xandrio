/**
 * A playback request's `?voiceId=` pin must respect the instance's voice
 * provider allowlist (XANDRIO_VOICE_PROVIDERS), as every other voice
 * selection does. It used to be checked against the full voice registry, so
 * a pin could generate audio with a provider the operator had disabled.
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
  bookNarration: { 'edge-book': { voiceId: 'en-US-AndrewMultilingualNeural', fallbackPolicy: 'wait' } }
}));

const { resolveNarrationContext } = require('../server').__test;

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
  const own = await resolveNarrationContext('edge-book', 0, { voiceId: 'en-US-AndrewMultilingualNeural' });
  assert.equal(own.actualVoiceId, 'en-US-AndrewMultilingualNeural');
  console.log("  ✓ a pin naming the book's own saved narrator still resolves");
  console.log('voice pin allowlist: 5 passed, 0 failed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
