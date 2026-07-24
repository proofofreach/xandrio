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

const AUDIO_PIPELINE_VERSION = 5;
// Bump whenever shared narration preparation changes. Chapter text hashes are
// computed before prepareTtsText(), so this version is what prevents already
// rendered audio from surviving a text-preparation fix.
const NARRATION_PREP_VERSION = 5;

/**
 * Deterministic pause (ms) appended to the audio of paragraph-final chunks.
 * PARAGRAPH_PAUSE_MS env overrides; 0 disables. Read per call so tests and a
 * running server pick up env changes without a restart. Lives here (not in
 * chunked-tts) because the value is part of every variant key.
 */
function getParagraphPauseMs() {
  const raw = process.env.PARAGRAPH_PAUSE_MS;
  if (raw === undefined || raw === '') return 350;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 5000) : 350;
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
    return `${voiceId}${prefix}:profile${profile}:chunk${chunkSize}:fmt${format}:out${outputFormat}${suffix}:prep${NARRATION_PREP_VERSION}:audio${AUDIO_PIPELINE_VERSION}:br${bitrate}:pause${pauseMs}`;
  };

  const getConcurrency = (profile = process.env[`${envPrefix}_PROFILE`]) => {
    const configured = Number(process.env[`${envPrefix}_CONCURRENCY`] || 0);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    return getProfileConfig(profile).maxConcurrent;
  };

  return { isVoice, getVoiceName, normalizeProfile, getProfileConfig, getChunkSize, getVariantKey, getConcurrency };
}

module.exports = {
  createEngineProfile,
  AUDIO_PIPELINE_VERSION,
  NARRATION_PREP_VERSION,
  getParagraphPauseMs
};
