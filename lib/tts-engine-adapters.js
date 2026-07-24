const {
  isKokoroVoice,
  getKokoroVoiceName,
  getKokoroChunkSize,
  getKokoroVariantKey,
  getKokoroConcurrency,
  normalizeKokoroProfile,
  prepareKokoroText
} = require('./kokoro-tuning');
const {
  isChatterboxVoice,
  getChatterboxVoiceName,
  getChatterboxChunkSize,
  getChatterboxVariantKey,
  getChatterboxConcurrency,
  normalizeChatterboxProfile
} = require('./chatterbox-tuning');
const { masteringGainForEngine, getMasteringBitrate } = require('./audio-quality');
const { AUDIO_PIPELINE_VERSION, NARRATION_PREP_VERSION } = require('./tts-engine-profile');
const { getTtsOutputFormatForVoice } = require('./tts-output-format');
const { prepareTtsText } = require('./tts-text');

function kokoroLanguage(language, voice) {
  return typeof voice === 'string' && voice.startsWith('bm_') ? 'en-gb' : language;
}

function getKokoroAudioFormat() {
  const value = String(process.env.KOKORO_TTS_AUDIO_FORMAT || process.env.KOKORO_TTS_FORMAT || 'wav').toLowerCase();
  return value === 'mp3' ? 'mp3' : 'wav';
}

function getChatterboxAudioFormat() {
  const value = String(process.env.CHATTERBOX_TTS_AUDIO_FORMAT || process.env.CHATTERBOX_TTS_FORMAT || 'wav').toLowerCase();
  return value === 'mp3' ? 'mp3' : 'wav';
}

const KOKORO_HTTP = Object.freeze({
  label: 'Kokoro TTS',
  baseUrl: () => (process.env.KOKORO_TTS_URL || 'http://127.0.0.1:8766').replace(/\/+$/, ''),
  format: getKokoroAudioFormat,
  timeout: queue => queue.timeout,
  backoffBaseMs: 250,
  backoffMaxMs: 2000
});

const CHATTERBOX_HTTP = Object.freeze({
  label: 'Chatterbox TTS',
  baseUrl: () => (process.env.CHATTERBOX_TTS_URL || 'http://127.0.0.1:8767').replace(/\/+$/, ''),
  format: getChatterboxAudioFormat,
  timeout: queue => {
    const configured = Number(process.env.CHATTERBOX_TIMEOUT_MS || 0);
    return Number.isFinite(configured) && configured > 0 ? configured : Math.max(queue.timeout, 180000);
  },
  backoffBaseMs: 500,
  backoffMaxMs: 3000
});

/**
 * The authoritative engine definitions. Identity, capabilities, tuning,
 * cache identity, and generation dispatch live together so the queue and
 * lifecycle registry cannot construct subtly different engine tables.
 */
const ENGINE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'kokoro',
    matches: isKokoroVoice,
    capabilities: Object.freeze({ local: true, gpu: true, voiceCloning: false }),
    http: KOKORO_HTTP,
    narration: Object.freeze({ headingCue: '.', headingPauseMs: 550, paragraphPauseMs: 350, dialoguePauseMs: 375 }),
    composeLifecycle: bindings => ({
      start: bindings.kokoroStart,
      stop: bindings.kokoroStop,
      health: bindings.kokoroHealth,
      processHint: bindings.kokoroProcessHint,
      supervised: false
    }),
    profile: () => normalizeKokoroProfile(),
    chunkSize: voice => getKokoroChunkSize(voice),
    concurrency: () => getKokoroConcurrency(),
    variantKey: voice => getKokoroVariantKey(voice),
    generate: (queue, { text, outputPath, language, voice, padEndMs, signal }) => {
      const engineVoice = isKokoroVoice(voice) ? getKokoroVoiceName(voice) : 'af_heart';
      const prepared = prepareKokoroText(text);
      return queue._generateHttpTTS(
        KOKORO_HTTP,
        prepared.text,
        outputPath,
        { language: kokoroLanguage(language, engineVoice), voice: engineVoice },
        padEndMs,
        masteringGainForEngine('kokoro'),
        signal
      );
    }
  }),
  Object.freeze({
    id: 'chatterbox',
    matches: isChatterboxVoice,
    capabilities: Object.freeze({ local: true, gpu: true, voiceCloning: true }),
    http: CHATTERBOX_HTTP,
    narration: Object.freeze({ headingCue: '…', headingPauseMs: 650, paragraphPauseMs: 400, dialoguePauseMs: 425 }),
    composeLifecycle: bindings => ({
      start: bindings.chatterboxStart,
      stop: bindings.chatterboxStop,
      health: bindings.chatterboxHealth,
      processHint: bindings.chatterboxProcessHint,
      supervised: true
    }),
    profile: () => normalizeChatterboxProfile(),
    chunkSize: voice => getChatterboxChunkSize(voice),
    concurrency: () => getChatterboxConcurrency(),
    variantKey: (voice, options) => {
      const refVersion = options.chatterboxRefVersion(voice);
      return getChatterboxVariantKey(voice, {
        refVersion: refVersion || undefined,
        platform: options.platform,
        engine: options.chatterboxEngine
      });
    },
    generate: (queue, { text, outputPath, voice, padEndMs, signal }) => queue._generateHttpTTS(
      CHATTERBOX_HTTP,
      text,
      outputPath,
      { voice: getChatterboxVoiceName(voice) },
      padEndMs,
      masteringGainForEngine('chatterbox'),
      signal
    )
  }),
  Object.freeze({
    id: 'edge',
    matches: () => true,
    capabilities: Object.freeze({ local: false, gpu: false, voiceCloning: false }),
    narration: Object.freeze({ headingCue: ':', headingPauseMs: 500, paragraphPauseMs: 300, dialoguePauseMs: 325 }),
    composeLifecycle: bindings => ({
      health: bindings.edgeHealth || (async () => true),
      supervised: false
    }),
    profile: () => 'default',
    chunkSize: (_voice, options) => options.defaultChunkSize,
    concurrency: (_voice, options) => options.defaultConcurrency,
    variantKey: (voice, options) => `${voice}:chunk${options.defaultChunkSize}:out${getTtsOutputFormatForVoice(voice)}:prep${NARRATION_PREP_VERSION}:audio${AUDIO_PIPELINE_VERSION}:br${getMasteringBitrate()}`,
    generate: (queue, context) => queue._generateEdgeTTS({
      ...context,
      gainDb: masteringGainForEngine('edge')
    })
  })
]);

class TtsEngineAdapterRegistry {
  constructor(adapters = []) {
    if (!Array.isArray(adapters) || adapters.length === 0) throw new Error('At least one TTS engine adapter is required');
    this.adapters = adapters.slice();
  }

  resolve(voice) {
    const adapter = this.adapters.find(candidate => candidate.matches(voice));
    if (!adapter) throw new Error(`No TTS engine adapter accepts voice: ${voice}`);
    return adapter;
  }

  describe(voice) {
    const adapter = this.resolve(voice);
    return { id: adapter.id, capabilities: { ...(adapter.capabilities || {}) } };
  }

  forEach(callback) { this.adapters.forEach(callback); }
  ids() { return this.adapters.map(adapter => adapter.id); }
}

function adaptNarrationForEngine(engineId, text, narration, padEndMs = 0) {
  const definition = ENGINE_DEFINITIONS.find(candidate => candidate.id === engineId) || ENGINE_DEFINITIONS.at(-1);
  if (!Array.isArray(narration?.segments) || narration.segments.length === 0) {
    return { text, padEndMs };
  }
  let adaptedText = text;
  for (const segment of narration.segments) {
    // The chunk text has already passed through prepareTtsText, so the raw
    // segment text must receive the same preparation before it can match.
    const segmentText = prepareTtsText(String(segment?.text || '')).trim();
    if (segment?.kind !== 'heading' || !segmentText || /[.!?…:]$/.test(segmentText)) continue;
    adaptedText = adaptedText.replace(segmentText, `${segmentText}${definition.narration.headingCue}`);
  }
  let pauseFloor = narration.pauseIntent === 'heading'
    ? definition.narration.headingPauseMs
    : narration.pauseIntent === 'paragraph' ? definition.narration.paragraphPauseMs : 0;
  if (narration.segments.some(segment => segment?.kind === 'dialogue')) {
    pauseFloor = Math.max(pauseFloor, definition.narration.dialoguePauseMs);
  }
  return { text: adaptedText || text, padEndMs: Math.max(padEndMs || 0, pauseFloor) };
}

function createEngineAdapterRegistry(options = {}) {
  const factoryOptions = {
    defaultChunkSize: options.defaultChunkSize || 4000,
    defaultConcurrency: options.defaultConcurrency || 2,
    chatterboxRefVersion: options.chatterboxRefVersion || (() => null),
    platform: options.platform || process.platform,
    chatterboxEngine: options.chatterboxEngine ?? process.env.CHATTERBOX_ENGINE
  };
  const lifecycleBindings = options.lifecycleBindings || {};
  const overrides = options.overrides || {};

  return new TtsEngineAdapterRegistry(ENGINE_DEFINITIONS.map(definition => {
    const override = overrides[definition.id] || {};
    const capabilities = { ...definition.capabilities, ...(override.capabilities || {}) };
    const queue = options.queue;
    return {
      ...definition,
      ...override,
      capabilities,
      usesGpu: capabilities.gpu,
      lifecycle: override.lifecycle || definition.composeLifecycle(lifecycleBindings),
      profile: voice => (override.profile || definition.profile)(voice, factoryOptions),
      chunkSize: voice => (override.chunkSize || definition.chunkSize)(voice, factoryOptions),
      concurrency: voice => (override.concurrency || definition.concurrency)(voice, factoryOptions),
      variantKey: voice => (override.variantKey || definition.variantKey)(voice, factoryOptions),
      generate: override.generate || (queue
        ? context => definition.generate(queue, context)
        : undefined)
    };
  }));
}

module.exports = TtsEngineAdapterRegistry;
module.exports.ENGINE_DEFINITIONS = ENGINE_DEFINITIONS;
module.exports.createEngineAdapterRegistry = createEngineAdapterRegistry;
module.exports.adaptNarrationForEngine = adaptNarrationForEngine;
module.exports.getKokoroAudioFormat = getKokoroAudioFormat;
module.exports.getChatterboxAudioFormat = getChatterboxAudioFormat;
