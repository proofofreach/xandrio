/** Per-instance voice-provider allowlist tests. */

const assert = require('assert');
const { parseVoiceProviders, filterVoicesByProvider } = require('../lib/voice-catalog');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

const VOICES = [
  { id: 'edge-1', provider: 'Edge' },
  { id: 'kokoro:af_heart', provider: 'Kokoro' },
  { id: 'chatterbox:brick-scott', provider: 'Chatterbox' },
  { id: 'chatterbox:clone', provider: 'Chatterbox', custom: true }
];

test('unset or empty env means all providers', () => {
  assert.strictEqual(parseVoiceProviders(undefined), null);
  assert.strictEqual(parseVoiceProviders(''), null);
  assert.strictEqual(parseVoiceProviders('  ,, '), null);
  assert.deepStrictEqual(filterVoicesByProvider(VOICES, null), VOICES);
});

test('allowlist filters case-insensitively and covers custom voices', () => {
  const allowed = parseVoiceProviders(' Edge , KOKORO ');
  const filtered = filterVoicesByProvider(VOICES, allowed);
  assert.deepStrictEqual(filtered.map(v => v.id), ['edge-1', 'kokoro:af_heart']);
});

test('a chatterbox-only allowlist keeps clones', () => {
  const filtered = filterVoicesByProvider(VOICES, parseVoiceProviders('chatterbox'));
  assert.deepStrictEqual(filtered.map(v => v.id), ['chatterbox:brick-scott', 'chatterbox:clone']);
});

console.log(`\n${'═'.repeat(50)}`);
console.log(`voice catalog tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
