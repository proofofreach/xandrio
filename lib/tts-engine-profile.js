// Shared scaffolding for HTTP TTS engine tuning modules (Kokoro,
// Chatterbox). Each engine supplies its voice-id prefix, env-var
// namespace, profile/override tables, and optional variant-key extras;
// the factory provides the common profile/chunk-size/variant-key/
// concurrency logic. Env vars are read at call time, matching the
// original per-engine implementations.

// Bump whenever chunk audio post-processing changes (filter chain, bitrate,
// paragraph padding in lib/tts-queue.js buildChunkEncodeArgs) — it is folded
// into every variant key so all cached audio regenerates.
const { getMasteringBitrate } = require('./audio-quality');
const { getTtsOutputFormatForVoice } = require('./tts-output-format');
const {
  normalizeSplitPolicy,
  splitPolicyVariantSuffix
} = require('./tts-split-policy');

const AUDIO_PIPELINE_VERSION = 7;
// Bump whenever shared narration preparation changes. Chapter text hashes are
// computed before prepareTtsText(), so this version is what prevents already
// rendered audio from surviving a text-preparation fix.
const NARRATION_PREP_VERSION = 11;

// Keep the native media element active while giving the listener a deliberate
// boundary between chapters. Baking this into the chapter's final chunk makes
// the pause work for continuous streams, finite fallbacks, and offline audio,
// including when a locked phone suspends page timers.
const CHAPTER_PAUSE_MS = 5000;
const DEFAULT_PARAGRAPH_PAUSE_MS = 350;

/**
 * Deterministic pause (ms) appended to the audio of paragraph-final chunks.
 * PARAGRAPH_PAUSE_MS env overrides; 0 disables. Read per call so tests and a
 * running server pick up env changes without a restart. Lives here (not in
 * chunked-tts) because the value is part of every variant key.
 */
function getParagraphPauseMs() {
  const raw = process.env.PARAGRAPH_PAUSE_MS;
  if (raw === undefined || raw === '') return DEFAULT_PARAGRAPH_PAUSE_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 5000) : DEFAULT_PARAGRAPH_PAUSE_MS;
}

/**
 * Variant-key tail for audio-changing inputs that older keys never scoped
 * (mastering gain overrides, model repositories, sampling overrides, the Edge
 * paragraph pause). Compatibility rule: a component is appended ONLY when its
 * value differs from the value the production default has always implied, so
 * every chunk rendered under the default configuration keeps its key and its
 * cache, while an operator override can no longer be served audio generated
 * under different settings. `entries` are `{ tag, value, defaultValue }`;
 * `value` may be undefined/null/'' for "not configured", which never appends.
 */
function nonDefaultVariantSuffix(entries) {
  let suffix = '';
  for (const { tag, value, defaultValue } of entries || []) {
    if (value === undefined || value === null || value === '') continue;
    if (Object.is(value, defaultValue) || String(value) === String(defaultValue)) continue;
    suffix += `:${tag}${variantComponent(value)}`;
  }
  return suffix;
}

/** Keep variant components filename-safe and short; long values are hashed. */
function variantComponent(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._-]{1,24}$/.test(text)) return text.replace(/\./g, 'p').replace(/-/g, 'm');
  return require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 10);
}

/** Configured mastering gain for an engine env namespace, or undefined when not set. */
function configuredGainDb(envPrefix, env = process.env) {
  const raw = env[`${envPrefix}_MASTERING_GAIN_DB`];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function createEngineProfile({
  idPrefix,
  envPrefix,
  profiles,
  voiceOverrides = {},
  defaultProfile = 'balanced',
  variantExtras = null
}) {
  const isVoice = (voiceId) => typeof voiceId === 'string' && voiceId.startsWith(idPrefix);

  const getVoiceName = (voiceId) => (isVoice(voiceId) ? voiceId.slice(idPrefix.length) : String(voiceId || ''));

  const normalizeProfile = (value) => {
    const profile = String(value || process.env[`${envPrefix}_PROFILE`] || defaultProfile).toLowerCase();
    return profiles[profile] ? profile : defaultProfile;
  };

  const getProfileConfig = (profile = process.env[`${envPrefix}_PROFILE`]) => profiles[normalizeProfile(profile)];

  const getChunkSize = (voiceId, profile = process.env[`${envPrefix}_PROFILE`]) => {
    const normalizedProfile = normalizeProfile(profile);
    const configured = Number(process.env[`${envPrefix}_CHUNK_SIZE`] || 0);
    if (Number.isFinite(configured) && configured > 0) return Math.round(configured);

    const voice = getVoiceName(voiceId);
    const override = voiceOverrides[voice]?.[normalizedProfile];
    if (override) return override;
    return profiles[normalizedProfile].chunkSize;
  };

  const getSplitPolicy = () => normalizeSplitPolicy(process.env[`${envPrefix}_SPLIT_POLICY`]);

  const getVariantKey = (voiceId, options = {}) => {
    const profile = normalizeProfile(options.profile);
    const chunkSize = getChunkSize(voiceId, profile);
    // Default mirrors the engine-format getters in lib/tts-queue.js. The
    // source format is distinct from the final playback container below.
    const format = String(
      options.format ||
      process.env[`${envPrefix}_TTS_AUDIO_FORMAT`] ||
      process.env[`${envPrefix}_TTS_FORMAT`] ||
      'wav'
    ).toLowerCase() === 'mp3' ? 'mp3' : 'wav';
    const prefixValue = typeof variantExtras?.prefix === 'function'
      ? variantExtras.prefix(options)
      : variantExtras?.prefix;
    const prefix = prefixValue ? `:${prefixValue}` : '';
    const suffix = variantExtras?.suffix ? `:${variantExtras.suffix(options)}` : '';
    // The paragraph pause is baked into chunk audio, so it must scope the
    // cache — otherwise changing PARAGRAPH_PAUSE_MS would mix padded and
    // unpadded chunks inside already-cached chapters.
    const pauseMs = getParagraphPauseMs();
    const bitrate = getMasteringBitrate();
    const outputFormat = getTtsOutputFormatForVoice(voiceId);
    const splitSuffix = splitPolicyVariantSuffix(options.splitPolicy || getSplitPolicy());
    // Engine-specific audio-changing inputs, appended only when non-default
    // (see nonDefaultVariantSuffix) so existing caches keep their keys.
    const identitySuffix = nonDefaultVariantSuffix(variantExtras?.identity ? variantExtras.identity(options) : []);
    return `${voiceId}${prefix}:profile${profile}:chunk${chunkSize}:fmt${format}:out${outputFormat}${suffix}:prep${NARRATION_PREP_VERSION}:audio${AUDIO_PIPELINE_VERSION}:br${bitrate}:pause${pauseMs}${splitSuffix}${identitySuffix}`;
  };

  const getConcurrency = (profile = process.env[`${envPrefix}_PROFILE`]) => {
    const configured = Number(process.env[`${envPrefix}_CONCURRENCY`] || 0);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    return getProfileConfig(profile).maxConcurrent;
  };

  return {
    isVoice,
    getVoiceName,
    normalizeProfile,
    getProfileConfig,
    getChunkSize,
    getSplitPolicy,
    getVariantKey,
    getConcurrency
  };
}

module.exports = {
  createEngineProfile,
  nonDefaultVariantSuffix,
  configuredGainDb,
  AUDIO_PIPELINE_VERSION,
  NARRATION_PREP_VERSION,
  CHAPTER_PAUSE_MS,
  DEFAULT_PARAGRAPH_PAUSE_MS,
  getParagraphPauseMs
};
