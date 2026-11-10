const {
  isKokoroVoice,
  getKokoroVoiceName,
  getKokoroChunkSize,
  getKokoroSplitPolicy,
  getKokoroVariantKey,
  getKokoroConcurrency,
  normalizeKokoroProfile,
  prepareKokoroText
} = require('./kokoro-tuning');
const {
  isChatterboxVoice,
  getChatterboxVoiceName,
  getChatterboxChunkSize,
  getChatterboxSplitPolicy,
  getChatterboxVariantKey,
  getChatterboxConcurrency,
  normalizeChatterboxProfile,
  getChatterboxVoiceTuningIdentity,
  resolveChatterboxImplementation
} = require('./chatterbox-tuning');
const { masteringGainForEngine, getMasteringBitrate } = require('./audio-quality');
const {
  AUDIO_PIPELINE_VERSION,
  NARRATION_PREP_VERSION,
  DEFAULT_PARAGRAPH_PAUSE_MS,
  getParagraphPauseMs,
  nonDefaultVariantSuffix,
  configuredGainDb
} = require('./tts-engine-profile');
const { getTtsOutputFormatForVoice } = require('./tts-output-format');
const { DEFAULT_MINIMUM_TEXT_LENGTH, prepareTtsText } = require('./tts-text');
const { RAMP_SPLIT_POLICY, normalizeSplitPolicy, splitPolicyVariantSuffix } = require('./tts-split-policy');
const nano = require('./moss-nano-tuning');

// Edge starts with a short ramp so a cold Play waits for seconds of speech,
// not a 4000-character request. EDGE_SPLIT_POLICY=legacy-v1 restores the old
// chunking and, because legacy has no variant suffix, its cache namespace.
function getEdgeSplitPolicy() {
  return normalizeSplitPolicy(process.env.EDGE_SPLIT_POLICY || RAMP_SPLIT_POLICY);
}

const { normalizeLanguageCode } = require('./book-language');

// Book languages arrive as base codes (lib/book-language.js); normalizing
// again here keeps a raw caller (`en-US`, `EN`, `eng`) from slipping through.
const EDGE_LANGUAGE_VOICES = Object.freeze({
  en: Object.freeze({ voice: 'en-US-AndrewMultilingualNeural', language: 'en-US' }),
  de: Object.freeze({ voice: 'de-DE-FlorianMultilingualNeural', language: 'de-DE' }),
  es: Object.freeze({ voice: 'es-ES-AlvaroNeural', language: 'es-ES' }),
  fr: Object.freeze({ voice: 'fr-FR-RemyMultilingualNeural', language: 'fr-FR' }),
  it: Object.freeze({ voice: 'it-IT-GiuseppeMultilingualNeural', language: 'it-IT' }),
  pt: Object.freeze({ voice: 'pt-BR-AntonioNeural', language: 'pt-BR' }),
  ru: Object.freeze({ voice: 'ru-RU-DmitryNeural', language: 'ru-RU' }),
  zh: Object.freeze({ voice: 'zh-CN-YunxiNeural', language: 'zh-CN' }),
  ja: Object.freeze({ voice: 'ja-JP-KeitaNeural', language: 'ja-JP' })
});

/** The Edge voice that narrates a book: the user's choice for English books. */
function edgeVoiceForLanguage(language, overrideVoice) {
  const base = normalizeLanguageCode(language) || 'en';
  if (base === 'en' && overrideVoice) return { voice: overrideVoice, language: 'en-US' };
  return { ...(EDGE_LANGUAGE_VOICES[base] || EDGE_LANGUAGE_VOICES.en) };
}

// Languages Kokoro has its own G2P for besides English (kokoro-server.py
// LANG_MAP). Any other book language falls back to English phonemes.
const KOKORO_NATIVE_LANGUAGES = new Set(['es', 'fr', 'hi', 'it', 'ja', 'pt', 'zh']);

/**
 * The G2P language Kokoro reads a book with. English text follows the voice's
 * own accent: American voices (`af_`, `am_`) get American phonemes and British
 * voices (`bf_`, `bm_`) British ones, whatever region the book declared. The
 * American code stays `en` (the server maps `en` and `en-us` to the same
 * pipeline) so default English books keep their render fingerprints.
 */
function kokoroLanguage(language, voice) {
  const base = normalizeLanguageCode(language) || 'en';
  if (KOKORO_NATIVE_LANGUAGES.has(base)) return base;
  return typeof voice === 'string' && /^b[fm]_/.test(voice) ? 'en-gb' : 'en';
}

// Languages Chatterbox Multilingual V3 accepts as `language_id`.
const CHATTERBOX_V3_LANGUAGES = new Set([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms',
  'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh'
]);

/**
 * `language_id` for Chatterbox, or null to keep the server default (`en`).
 * Only Multilingual V3 (PyTorch) reads it; the original, Turbo and V3 MLX
 * servers are English-only. English stays null so English renders keep
 * their fingerprints.
 */
function chatterboxLanguage(language, engine = process.env.CHATTERBOX_ENGINE) {
  if (resolveChatterboxImplementation({ engine }) !== 'v3') return null;
  const base = normalizeLanguageCode(language) || 'en';
  return base !== 'en' && CHATTERBOX_V3_LANGUAGES.has(base) ? base : null;
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

const MOSS_NANO_HTTP = Object.freeze({
  label: 'MOSS Nano TTS', baseUrl: nano.baseUrl, format: () => 'wav',
  downmixBeforeLimiting: true,
  validationSeeds: nano.RECOVERY_SEEDS, recoveryPolicy: nano.RECOVERY_POLICY,
  seedRetryCodes: Object.freeze(['NANO_FRAME_LIMIT']),
  requireAudioValidation: true, adaptiveRecovery: true,
  timeout: queue => Math.max(queue.timeout, 190000), backoffBaseMs: 500, backoffMaxMs: 3000
});

/**
 * The authoritative engine definitions. Identity, capabilities, tuning,
 * cache identity, and generation dispatch live together so the queue and
 * lifecycle registry cannot construct subtly different engine tables.
 */
const ENGINE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'kokoro',
    artifactRevision: 1,
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
    splitPolicy: () => getKokoroSplitPolicy(),
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
    artifactRevision: 1,
    // T3 stops after max_new_tokens = 1000 speech tokens at 25 tokens/s, so
    // one request holds at most 40 s of speech. Slow audiobook pacing is ~10
    // chars/s (see maxExpectedChunkSeconds in tts-queue.js), so a longer
    // request can be cut off mid-sentence. Every profile chunk size (220-380)
    // is already under this bound.
    maximumTextLength: 400,
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
    splitPolicy: () => getChatterboxSplitPolicy(),
    concurrency: () => getChatterboxConcurrency(),
    variantKey: (voice, options) => {
      const refVersion = options.chatterboxRefVersion(voice);
      return getChatterboxVariantKey(voice, {
        refVersion: refVersion || undefined,
        platform: options.platform,
        engine: options.chatterboxEngine
      });
    },
    // Per-voice sidecar tuning rides on verified markers, not on the key.
    tuningIdentity: voice => getChatterboxVoiceTuningIdentity(voice),
    generate: (queue, { text, outputPath, language, voice, padEndMs, signal }) => queue._generateHttpTTS(
      CHATTERBOX_HTTP,
      text,
      outputPath,
      {
        voice: getChatterboxVoiceName(voice),
        ...(chatterboxLanguage(language) ? { language_id: chatterboxLanguage(language) } : {})
      },
      padEndMs,
      masteringGainForEngine('chatterbox'),
      signal
    )
  }),
  Object.freeze({
    id: 'moss-nano',
    minimumTextLength: 1,
    artifactRevision: 1,
    matches: nano.isMossNanoVoice,
    capabilities: Object.freeze({ local: true, gpu: false, voiceCloning: false }),
    schedulingResource: 'gpu',
    http: MOSS_NANO_HTTP,
    narration: Object.freeze({ headingCue: '.', headingPauseMs: 550, paragraphPauseMs: 350, dialoguePauseMs: 375 }),
    composeLifecycle: bindings => ({ start: bindings.mossNanoStart, stop: bindings.mossNanoStop,
      health: bindings.mossNanoHealth || (async () => false), processHint: bindings.mossNanoProcessHint, supervised: false }),
    profile: () => 'prepared', chunkSize: () => 160, splitPolicy: () => 'paragraph-v1', concurrency: () => 1,
    variantKey: nano.variantKey,
    masteringGain: nano.masteringGain,
    masteringOptions: Object.freeze({ downmixBeforeLimiting: true }),
    synthesisInput: (text, _language, voice) => ({ text, voice: nano.getMossNanoVoiceName(voice),
      language: null, sourceFormat: 'wav', ...nano.synthesisIdentity }),
    generate: (queue, { text, outputPath, voice, padEndMs, signal }) => {
      if (!nano.enabled()) throw new Error('MOSS Nano is disabled');
      return queue._generateHttpTTS(MOSS_NANO_HTTP, text, outputPath,
        { voice: nano.getMossNanoVoiceName(voice) }, padEndMs, nano.masteringGain(voice), signal);
    }
  }),
  Object.freeze({
    id: 'edge',
    artifactRevision: 1,
    matches: () => true,
    capabilities: Object.freeze({ local: false, gpu: false, voiceCloning: false }),
    narration: Object.freeze({ headingCue: ':', headingPauseMs: 500, paragraphPauseMs: 300, dialoguePauseMs: 325 }),
    composeLifecycle: bindings => ({
      health: bindings.edgeHealth || (async () => true),
      supervised: false
    }),
    profile: () => 'default',
    chunkSize: (_voice, options) => options.defaultChunkSize,
    splitPolicy: () => getEdgeSplitPolicy(),
    concurrency: (_voice, options) => options.defaultConcurrency,
    // Chunk boundaries are part of the audio identity: the split suffix keeps
    // ramp-chunked audio from colliding with legacy files of the same index.
    // The paragraph pause and mastering gain are baked into Edge chunks too but
    // were never in this key; they are appended only when non-default so the
    // existing Edge cache keeps its key (see nonDefaultVariantSuffix).
    variantKey: (voice, options) => `${voice}:chunk${options.defaultChunkSize}:out${getTtsOutputFormatForVoice(voice)}:prep${NARRATION_PREP_VERSION}:audio${AUDIO_PIPELINE_VERSION}:br${getMasteringBitrate()}${splitPolicyVariantSuffix(getEdgeSplitPolicy())}${nonDefaultVariantSuffix([
      { tag: 'pause', value: getParagraphPauseMs(), defaultValue: DEFAULT_PARAGRAPH_PAUSE_MS },
      { tag: 'gain', value: configuredGainDb('EDGE'), defaultValue: masteringGainForEngine('edge', {}) }
    ])}`,
    generate: (queue, context) => queue._generateEdgeTTS({
      ...context,
      gainDb: masteringGainForEngine('edge')
    })
  })
]);

/**
 * The text-length bounds one synthesis request must respect: the floor the
 * queue enforces before synthesis, and the most text the engine can render in
 * one request (null when it has no such bound). The chunk planner and the
 * queue both read this, so a planned chunk is always one the engine accepts.
 */
function engineTextLimits(adapter) {
  const minimum = Number(adapter?.minimumTextLength);
  const maximum = Number(adapter?.maximumTextLength);
  return {
    minChars: Number.isInteger(minimum) && minimum > 0 ? minimum : DEFAULT_MINIMUM_TEXT_LENGTH,
    maxChars: Number.isInteger(maximum) && maximum > 0 ? maximum : null
  };
}

/** engineTextLimits for the engine that serves `voice`. */
function engineTextLimitsForVoice(voice) {
  return engineTextLimits(ENGINE_DEFINITIONS.find(definition => definition.matches(voice)));
}

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
  if (narration.segments.some(segment => segment?.kind === 'heading')) {
    // Segments appear in chunk order. Locate each one after the previous
    // match, so a heading cue lands on the heading itself and not on an
    // earlier sentence that mentions the same words.
    let cursor = 0;
    for (const segment of narration.segments) {
      // The chunk text has already passed through prepareTtsText, so the raw
      // segment text must receive the same preparation before it can match.
      const segmentText = prepareTtsText(String(segment?.text || ''), { documentStart: false }).trim();
      const index = segmentText ? adaptedText.indexOf(segmentText, cursor) : -1;
      if (index < 0) continue;
      cursor = index + segmentText.length;
      if (segment.kind !== 'heading' || /[.!?…:]$/.test(segmentText)) continue;
      const cue = definition.narration.headingCue;
      adaptedText = `${adaptedText.slice(0, cursor)}${cue}${adaptedText.slice(cursor)}`;
      cursor += cue.length;
    }
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
      schedulingResource: override.schedulingResource ?? definition.schedulingResource ?? (capabilities.gpu ? 'gpu' : null),
      lifecycle: override.lifecycle || definition.composeLifecycle(lifecycleBindings),
      profile: voice => (override.profile || definition.profile)(voice, factoryOptions),
      chunkSize: voice => (override.chunkSize || definition.chunkSize)(voice, factoryOptions),
      splitPolicy: voice => (override.splitPolicy || definition.splitPolicy)(voice, factoryOptions),
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
module.exports.getEdgeSplitPolicy = getEdgeSplitPolicy;
module.exports.edgeVoiceForLanguage = edgeVoiceForLanguage;
module.exports.engineTextLimits = engineTextLimits;
module.exports.engineTextLimitsForVoice = engineTextLimitsForVoice;
module.exports.kokoroLanguage = kokoroLanguage;
module.exports.chatterboxLanguage = chatterboxLanguage;
