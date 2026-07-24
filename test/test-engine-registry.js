const assert = require('assert');
const { createNarrationEngineRegistry } = require('../lib/narration-engine-registry');
const TtsEngineAdapterRegistry = require('../lib/tts-engine-adapters');
const { createEngineAdapterRegistry, ENGINE_DEFINITIONS } = TtsEngineAdapterRegistry;
const TTSQueue = require('../lib/tts-queue');
const {
  getChatterboxVariantKey,
  resolveChatterboxImplementation
} = require('../lib/chatterbox-tuning');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const registry = createNarrationEngineRegistry({
  defaultChunkSize: 4000,
  defaultConcurrency: 2,
  chatterboxRefVersion: voice => voice === 'chatterbox:custom' ? 'voice-v2' : null
});

test('exposes the three real engine adapters', () => {
  assert.deepStrictEqual(registry.adapters(), ['kokoro', 'chatterbox', 'edge']);
});

test('resolves Kokoro tuning and cache identity', () => {
  const engine = registry.forVoice('kokoro:am_michael');
  assert.strictEqual(engine.id, 'kokoro');
  assert(engine.chunkSize < 4000);
  assert(engine.variantKey.includes('kokoro:am_michael'));
});

test('resolves Chatterbox reference identity', () => {
  const engine = registry.forVoice('chatterbox:custom');
  assert.strictEqual(engine.id, 'chatterbox');
  assert(engine.variantKey.includes(':refvoice-v2:'));
  assert.deepStrictEqual(engine.capabilities, { local: true, gpu: true, voiceCloning: true });
});

test('uses Edge as the fallback adapter', () => {
  const engine = registry.forVoice('en-US-AndrewMultilingualNeural');
  assert.strictEqual(engine.id, 'edge');
  assert.strictEqual(engine.chunkSize, 4000);
  assert.strictEqual(engine.concurrency, 2);
});

test('generation adapters are replaceable without queue conditionals', () => {
  const adapters = new TtsEngineAdapterRegistry([
    { id: 'custom', matches: voice => voice.startsWith('custom:'), generate: () => 'ok' },
    { id: 'fallback', matches: () => true, generate: () => 'fallback' }
  ]);
  assert.strictEqual(adapters.resolve('custom:narrator').id, 'custom');
  assert.strictEqual(adapters.resolve('unknown').id, 'fallback');
  assert.deepStrictEqual(adapters.describe('custom:narrator'), { id: 'custom', capabilities: {} });
});

test('generation and lifecycle registries share authoritative engine identity', () => {
  const adapters = createEngineAdapterRegistry({
    overrides: { chatterbox: { generate: () => 'audio' } }
  });
  const chatterbox = adapters.resolve('chatterbox:brick-scott');
  assert.strictEqual(chatterbox.id, 'chatterbox');
  assert.strictEqual(chatterbox.usesGpu, true);
  assert.strictEqual(chatterbox.capabilities.voiceCloning, true);
  assert.strictEqual(chatterbox.generate(), 'audio');
  assert.strictEqual(adapters.resolve('en-US-AndrewMultilingualNeural').id, 'edge');
});

test('authoritative definitions own generation, tuning, lifecycle identity, and capabilities', () => {
  for (const definition of ENGINE_DEFINITIONS) {
    assert.strictEqual(typeof definition.generate, 'function', `${definition.id} owns generation`);
    assert.strictEqual(typeof definition.chunkSize, 'function', `${definition.id} owns tuning`);
    assert.strictEqual(typeof definition.variantKey, 'function', `${definition.id} owns cache identity`);
    assert.strictEqual(typeof definition.composeLifecycle, 'function', `${definition.id} owns lifecycle composition`);
    assert(definition.capabilities && typeof definition.capabilities.gpu === 'boolean');
  }

  const queue = new TTSQueue();
  let generation = null;
  queue._generateHttpTTS = (engine, _text, _path, payload) => { generation = { engine, payload }; };
  const queueAdapter = queue.engineAdapters.resolve('chatterbox:brick-scott');
  const lifecycleAdapter = registry.forVoice('chatterbox:brick-scott');
  assert.strictEqual(queueAdapter.id, lifecycleAdapter.id);
  assert.deepStrictEqual(queueAdapter.capabilities, lifecycleAdapter.capabilities);
  queueAdapter.generate({ text: 'hello', outputPath: '/tmp/unused', voice: 'chatterbox:brick-scott' });
  assert.strictEqual(generation.engine, ENGINE_DEFINITIONS.find(definition => definition.id === 'chatterbox').http);
  assert.strictEqual(generation.payload.voice, 'brick-scott');
});

test('engine adapters own lifecycle and health hooks', () => {
  const calls = [];
  const managed = createNarrationEngineRegistry({
    lifecycleBindings: {
      kokoroStart: voice => calls.push(`start:${voice}`),
      kokoroStop: () => calls.push('stop:kokoro'),
      kokoroHealth: async () => true,
      kokoroProcessHint: () => true
    }
  });
  managed.start('kokoro:am_michael');
  assert(managed.health('kokoro:am_michael') instanceof Promise);
  assert.strictEqual(managed.processHint('kokoro:am_michael'), true);
  managed.stopAll();
  assert(calls.includes('start:kokoro:am_michael'));
  assert(calls.includes('stop:kokoro'));
});

test('Chatterbox definition owns supervised restart lifecycle binding', () => {
  const calls = [];
  const managed = createNarrationEngineRegistry({
    lifecycleBindings: {
      chatterboxStart: voice => calls.push(`supervisor:start:${voice}`),
      chatterboxStop: () => calls.push('supervisor:stop'),
      chatterboxHealth: async () => true,
      chatterboxProcessHint: () => true
    }
  });
  const engine = managed.forVoice('chatterbox:brick-scott');
  assert.strictEqual(engine.supervised, true);
  managed.start(engine.voice);
  assert.strictEqual(managed.processHint(engine.voice), true);
  managed.stopAll();
  assert(calls.includes('supervisor:start:chatterbox:brick-scott'));
  assert(calls.includes('supervisor:stop'));
});

test('Chatterbox implementation and cache identity agree across platform and env', () => {
  assert.strictEqual(resolveChatterboxImplementation({ platform: 'darwin', engine: '' }), 'mlx');
  assert.strictEqual(resolveChatterboxImplementation({ platform: 'linux', engine: '' }), 'pytorch');
  assert.strictEqual(resolveChatterboxImplementation({ platform: 'linux', engine: 'mlx' }), 'mlx');
  assert.strictEqual(resolveChatterboxImplementation({ platform: 'darwin', engine: 'pytorch' }), 'pytorch');
  assert.strictEqual(resolveChatterboxImplementation({ platform: 'darwin', engine: 'v3' }), 'v3');
  assert.strictEqual(resolveChatterboxImplementation({ platform: 'darwin', engine: 'v3-mlx' }), 'v3-mlx');

  const darwinDefault = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: '' });
  const linuxDefault = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'linux', engine: '' });
  const linuxMlx = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'linux', engine: 'mlx' });
  const v3 = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: 'v3' });
  const v3Mlx = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: 'v3-mlx' });
  assert(darwinDefault.includes(':modeloriginal8bit:'));
  assert(linuxDefault.includes(':modelturbo:'));
  assert(linuxMlx.includes(':modeloriginal8bit:'));
  assert(v3.includes(':modelmultilingualv3:'));
  assert(v3Mlx.includes(':modelmultilingualv3mlx8bit:'));
  assert.notStrictEqual(v3, v3Mlx);
  assert.notStrictEqual(darwinDefault, linuxDefault);

  const linuxRegistry = createNarrationEngineRegistry({ platform: 'linux', chatterboxEngine: '' });
  const darwinRegistry = createNarrationEngineRegistry({ platform: 'darwin', chatterboxEngine: '' });
  assert(linuxRegistry.forVoice('chatterbox:brick-scott').variantKey.includes(':modelturbo:'));
  assert(darwinRegistry.forVoice('chatterbox:brick-scott').variantKey.includes(':modeloriginal8bit:'));
});

test('recorded Chatterbox variants reject implementation, reference, and unavailable-voice drift', () => {
  const mlxRegistry = createNarrationEngineRegistry({
    platform: 'darwin',
    chatterboxEngine: 'mlx',
    chatterboxRefVersion: () => 'reference-v1'
  });
  const pytorchRegistry = createNarrationEngineRegistry({
    platform: 'linux',
    chatterboxEngine: 'pytorch',
    chatterboxRefVersion: () => 'reference-v2'
  });
  const voice = 'chatterbox:brick-scott';
  const recordedMlx = mlxRegistry.forVoice(voice).variantKey;
  const implementationMismatch = pytorchRegistry.validateRecordedVariant({
    voice, variantKey: recordedMlx, availableVoiceIds: [voice]
  });
  assert.strictEqual(implementationMismatch.compatible, false);

  const oldReference = createNarrationEngineRegistry({
    platform: 'linux', chatterboxEngine: 'pytorch', chatterboxRefVersion: () => 'reference-v1'
  }).forVoice(voice).variantKey;
  assert.strictEqual(pytorchRegistry.validateRecordedVariant({
    voice, variantKey: oldReference, availableVoiceIds: [voice]
  }).compatible, false);
  assert.strictEqual(pytorchRegistry.validateRecordedVariant({
    voice, variantKey: pytorchRegistry.forVoice(voice).variantKey, availableVoiceIds: []
  }).compatible, false);
});

console.log(`engine-registry tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
