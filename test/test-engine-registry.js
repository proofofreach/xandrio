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

test('exposes the four real engine adapters', () => {
  assert.deepStrictEqual(registry.adapters(), ['kokoro', 'chatterbox', 'moss-nano', 'edge']);
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getKokoroVariantKey } = require('../lib/kokoro-tuning');
const { getChatterboxVoiceTuningIdentity, SAMPLING_DEFAULTS } = require('../lib/chatterbox-tuning');
const { narrationRenderRecipe } = require('../lib/narration-render-recipe');

function withEnv(overrides, fn) {
  const previous = {};
  for (const [name, value] of Object.entries(overrides)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const IDENTITY_ENV = {
  CHATTERBOX_TEMPERATURE: undefined, CHATTERBOX_TOP_P: undefined, CHATTERBOX_EXAGGERATION: undefined,
  CHATTERBOX_CFG_WEIGHT: undefined, CHATTERBOX_REPETITION_PENALTY: undefined, CHATTERBOX_MIN_P: undefined,
  CHATTERBOX_MASTERING_GAIN_DB: undefined, KOKORO_REPO_ID: undefined, KOKORO_MASTERING_GAIN_DB: undefined,
  EDGE_MASTERING_GAIN_DB: undefined, PARAGRAPH_PAUSE_MS: undefined,
  // Profile and chunk settings also shape the key; an operator .env must not
  // leak into the default-configuration assertions.
  KOKORO_PROFILE: undefined, KOKORO_CHUNK_SIZE: undefined,
  CHATTERBOX_PROFILE: undefined, CHATTERBOX_CHUNK_SIZE: undefined, CHATTERBOX_MLX_MODEL: undefined,
  CHATTERBOX_ENGINE: undefined
};
const edgeKey = () => createEngineAdapterRegistry({ defaultChunkSize: 4000 })
  .resolve('en-US-AndrewMultilingualNeural').variantKey('en-US-AndrewMultilingualNeural');

test('default configuration keeps every historical variant key byte-for-byte', () => withEnv(IDENTITY_ENV, () => {
  // These are the key shapes the production cache was built with. Any new
  // identity component may only appear for a non-default value.
  assert.strictEqual(getKokoroVariantKey('kokoro:am_michael'),
    'kokoro:am_michael:profilequality:chunk440:fmtwav:outmp3:prep11:audio7:br160k:pause350');
  assert.strictEqual(getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: '' }),
    'chatterbox:brick-scott:modeloriginal8bit:profilebalanced:chunk280:fmtwav:outmp3:refbrick-scott-20260707:prep11:audio7:br160k:pause350');
  assert.strictEqual(edgeKey(), 'en-US-AndrewMultilingualNeural:chunk4000:outmp3:prep11:audio7:br160k:splitramp1');
}));

test('restating a default in the environment leaves variant keys unchanged', () => withEnv(IDENTITY_ENV, () => {
  const kokoro = getKokoroVariantKey('kokoro:am_michael');
  const mlx = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: 'mlx' });
  const edge = edgeKey();
  withEnv({
    KOKORO_REPO_ID: 'hexgrad/Kokoro-82M', KOKORO_MASTERING_GAIN_DB: '9.5',
    CHATTERBOX_TEMPERATURE: String(SAMPLING_DEFAULTS.mlx.temperature), CHATTERBOX_TOP_P: '0.95',
    CHATTERBOX_EXAGGERATION: '0.5', CHATTERBOX_CFG_WEIGHT: '0.5', CHATTERBOX_MASTERING_GAIN_DB: '2.5',
    EDGE_MASTERING_GAIN_DB: '3', PARAGRAPH_PAUSE_MS: '350'
  }, () => {
    assert.strictEqual(getKokoroVariantKey('kokoro:am_michael'), kokoro);
    assert.strictEqual(getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: 'mlx' }), mlx);
    assert.strictEqual(edgeKey(), edge);
  });
}));

test('non-default audio-changing settings scope the variant key', () => withEnv(IDENTITY_ENV, () => {
  const kokoro = getKokoroVariantKey('kokoro:am_michael');
  withEnv({ KOKORO_REPO_ID: 'someone/Kokoro-fork' }, () => {
    const forked = getKokoroVariantKey('kokoro:am_michael');
    assert.notStrictEqual(forked, kokoro);
    assert(/:repo[a-f0-9]{10}$/.test(forked), `repo override is hashed into the key: ${forked}`);
  });
  withEnv({ KOKORO_MASTERING_GAIN_DB: '6' }, () => {
    assert.strictEqual(getKokoroVariantKey('kokoro:am_michael'), `${kokoro}:gain6`);
  });

  // Sampling defaults differ per implementation: 0.76 is Turbo's default but
  // an override for MLX, so only the MLX key changes.
  withEnv({ CHATTERBOX_TEMPERATURE: '0.76' }, () => {
    const mlx = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: 'mlx' });
    const turbo = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'linux', engine: 'pytorch' });
    assert(mlx.endsWith(':temp0p76'), mlx);
    assert(!/:temp/.test(turbo), turbo);
  });
  withEnv({ CHATTERBOX_TOP_P: '0.8', CHATTERBOX_EXAGGERATION: '0.9', CHATTERBOX_CFG_WEIGHT: '0.1', CHATTERBOX_MASTERING_GAIN_DB: '-1.5' }, () => {
    const mlx = getChatterboxVariantKey('chatterbox:brick-scott', { platform: 'darwin', engine: 'mlx' });
    assert(mlx.endsWith(':topp0p8:exag0p9:cfg0p1:gainm1p5'), mlx);
  });

  const edge = edgeKey();
  withEnv({ PARAGRAPH_PAUSE_MS: '500' }, () => assert.strictEqual(edgeKey(), `${edge}:pause500`));
  withEnv({ EDGE_MASTERING_GAIN_DB: '0' }, () => assert.strictEqual(edgeKey(), `${edge}:gain0`));
}));

test('per-voice sidecar tuning yields a stable identity that rides on the recipe, not the fingerprint', () => {
  const voiceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-voice-tuning-'));
  try {
    const sidecar = path.join(voiceDir, 'custom.json');
    assert.strictEqual(getChatterboxVoiceTuningIdentity('chatterbox:custom', { voiceDir, now: 0 }), null, 'no sidecar: no identity');
    fs.writeFileSync(sidecar, JSON.stringify({ temperature: 0.6, top_p: 0.92, seed: 31, comment: 'ignored' }));
    const first = getChatterboxVoiceTuningIdentity('chatterbox:custom', { voiceDir, now: 10_000 });
    assert(/^[a-f0-9]{16}$/.test(first), `identity is a short hash: ${first}`);
    assert.strictEqual(getChatterboxVoiceTuningIdentity('chatterbox:custom', { voiceDir, now: 10_000 }), first, 'cached identity is stable');
    fs.writeFileSync(sidecar, JSON.stringify({ temperature: 0.6, top_p: 0.92, seed: 31, comment: 'edited but ignored' }));
    assert.strictEqual(getChatterboxVoiceTuningIdentity('chatterbox:custom', { voiceDir, now: 20_000 }), first,
      'keys the server ignores do not change the identity');
    fs.writeFileSync(sidecar, JSON.stringify({ temperature: 0.7, top_p: 0.92, seed: 31 }));
    const changed = getChatterboxVoiceTuningIdentity('chatterbox:custom', { voiceDir, now: 30_000 });
    assert.notStrictEqual(changed, first, 'an accepted-key change changes the identity');
    fs.writeFileSync(sidecar, '{not json');
    assert.strictEqual(getChatterboxVoiceTuningIdentity('chatterbox:custom', { voiceDir, now: 40_000 }), null, 'an unreadable sidecar has no identity');
    assert.strictEqual(getChatterboxVoiceTuningIdentity('chatterbox:../custom', { voiceDir, now: 50_000 }), null, 'path characters never escape the voice directory');

    const adapter = createEngineAdapterRegistry({ defaultChunkSize: 4000 }).resolve('chatterbox:custom');
    assert.strictEqual(typeof adapter.tuningIdentity, 'function', 'Chatterbox exposes the sidecar identity');
    const base = { adapter: { ...adapter, variantKey: () => 'chatterbox:custom:fixed' }, text: 'A narration long enough to count as speakable.', outputPath: '/tmp/chunk.mp3', voice: 'chatterbox:custom' };
    const without = narrationRenderRecipe({ ...base, adapter: { ...base.adapter, tuningIdentity: () => null } });
    const with_ = narrationRenderRecipe({ ...base, adapter: { ...base.adapter, tuningIdentity: () => 'abcdef0123456789' } });
    assert.strictEqual(without.tuning, null);
    assert.strictEqual(with_.tuning, 'abcdef0123456789');
    assert.strictEqual(with_.fingerprint, without.fingerprint, 'the sidecar never changes the fingerprint existing markers were written with');
  } finally {
    fs.rmSync(voiceDir, { recursive: true, force: true });
  }
});

console.log(`engine-registry tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
