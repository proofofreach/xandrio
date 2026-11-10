const crypto = require('crypto');
const {
  MASTERING_POLICY,
  buildMasteringArgs,
  getMasteringBitrate,
  masteringGainForEngine
} = require('./audio-quality');
const {
  adaptNarrationForEngine,
  chatterboxLanguage,
  edgeVoiceForLanguage,
  engineTextLimits,
  getChatterboxAudioFormat,
  getKokoroAudioFormat,
  kokoroLanguage
} = require('./tts-engine-adapters');
const { getChatterboxVoiceName } = require('./chatterbox-tuning');
const { getKokoroVoiceName, prepareKokoroText } = require('./kokoro-tuning');
const { prepareTtsText, isSpeakableText } = require('./tts-text');
const { outputFormatFromPath } = require('./tts-output-format');

const RECIPE_SCHEMA_VERSION = 1;

function stableVariantIdentity(variantKey, engineId, voice) {
  const value = String(variantKey || `${engineId}:${voice}`);
  return value
    .replace(/:prep\d+(?=:|$)/g, '')
    .replace(/:audio\d+(?=:|$)/g, '')
    .replace(/:pause\d+(?=:|$)/g, '');
}

function synthesisInput(engineId, text, language, voice) {
  if (engineId === 'kokoro') {
    const engineVoice = getKokoroVoiceName(voice) || 'af_heart';
    return {
      text: prepareKokoroText(text).text,
      voice: engineVoice,
      language: kokoroLanguage(language, engineVoice),
      sourceFormat: getKokoroAudioFormat()
    };
  }
  if (engineId === 'chatterbox') {
    return {
      text,
      voice: getChatterboxVoiceName(voice),
      language: chatterboxLanguage(language),
      sourceFormat: getChatterboxAudioFormat()
    };
  }
  const selected = edgeVoiceForLanguage(language, voice);
  return {
    text,
    voice: selected.voice,
    language: selected.language,
    sourceFormat: 'mp3'
  };
}

function narrationRenderRecipe({
  adapter,
  text,
  outputPath,
  language = 'en',
  voice,
  variantKey = null,
  padEndMs = 0,
  narration = null
}) {
  if (!adapter?.id) throw new TypeError('adapter is required');
  const preparedText = prepareTtsText(text, { documentStart: false });
  if (!isSpeakableText(preparedText, { minimumLength: engineTextLimits(adapter).minChars })) throw new Error('TTS input has no speakable text');
  const adapted = adaptNarrationForEngine(adapter.id, preparedText, narration, padEndMs);
  const synthesis = adapter.synthesisInput
    ? adapter.synthesisInput(adapted.text, language, voice)
    : synthesisInput(adapter.id, adapted.text, language, voice);
  const outputFormat = outputFormatFromPath(outputPath);
  const gainDb = adapter.masteringGain ? adapter.masteringGain(voice) : masteringGainForEngine(adapter.id);
  const masteringArgs = buildMasteringArgs({
    ...adapter.masteringOptions,
    inputFormat: synthesis.sourceFormat,
    outputPath: `artifact.${outputFormat}`,
    outputFormat,
    padEndMs: adapted.padEndMs,
    gainDb
  });
  const resolvedVariantKey = variantKey || (typeof adapter.variantKey === 'function'
    ? adapter.variantKey(voice)
    : `${adapter.id}:${voice}`);
  const recipe = {
    schemaVersion: RECIPE_SCHEMA_VERSION,
    engine: adapter.id,
    adapterRevision: Number.isInteger(adapter.artifactRevision) ? adapter.artifactRevision : 1,
    variant: stableVariantIdentity(resolvedVariantKey, adapter.id, voice),
    synthesis,
    mastering: {
      outputFormat,
      bitrate: getMasteringBitrate(),
      sampleRate: MASTERING_POLICY.sampleRate,
      channels: MASTERING_POLICY.channels,
      gainDb,
      padEndMs: adapted.padEndMs,
      args: masteringArgs
    }
  };
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(recipe))
    .digest('hex');
  // Per-voice sidecar tuning (Chatterbox voice-references/<voice>.json) is kept
  // out of the fingerprint on purpose: voices that already have a sidecar would
  // otherwise invalidate every verified chunk. It is recorded on new markers and
  // compared only when a marker carries it (NarrationArtifactCache).
  const tuning = typeof adapter.tuningIdentity === 'function' ? adapter.tuningIdentity(voice) ?? null : null;
  return {
    fingerprint,
    tuning: typeof tuning === 'string' && tuning ? tuning : null,
    recipe,
    render: {
      adapter,
      text: adapted.text,
      language,
      voice,
      padEndMs: adapted.padEndMs,
      narration
    }
  };
}

module.exports = {
  RECIPE_SCHEMA_VERSION,
  narrationRenderRecipe,
  stableVariantIdentity
};
