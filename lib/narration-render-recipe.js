const crypto = require('crypto');
const {
  MASTERING_POLICY,
  buildMasteringArgs,
  getMasteringBitrate,
  masteringGainForEngine
} = require('./audio-quality');
const {
  adaptNarrationForEngine,
  getChatterboxAudioFormat,
  getKokoroAudioFormat
} = require('./tts-engine-adapters');
const { getChatterboxVoiceName } = require('./chatterbox-tuning');
const { getKokoroVoiceName, prepareKokoroText } = require('./kokoro-tuning');
const { prepareTtsText, isSpeakableText } = require('./tts-text');
const { outputFormatFromPath } = require('./tts-output-format');

const RECIPE_SCHEMA_VERSION = 1;

function edgeVoiceForLanguage(language, overrideVoice) {
  const voices = {
    en: { voice: 'en-US-AndrewMultilingualNeural', language: 'en-US' },
    de: { voice: 'de-DE-FlorianMultilingualNeural', language: 'de-DE' },
    es: { voice: 'es-ES-AlvaroNeural', language: 'es-ES' },
    fr: { voice: 'fr-FR-RemyMultilingualNeural', language: 'fr-FR' },
    it: { voice: 'it-IT-GiuseppeMultilingualNeural', language: 'it-IT' },
    pt: { voice: 'pt-BR-AntonioNeural', language: 'pt-BR' },
    ru: { voice: 'ru-RU-DmitryNeural', language: 'ru-RU' },
    zh: { voice: 'zh-CN-YunxiNeural', language: 'zh-CN' },
    ja: { voice: 'ja-JP-KeitaNeural', language: 'ja-JP' }
  };
  const selected = voices[language] || voices.en;
  if ((!language || language === 'en' || language === 'en-us') && overrideVoice) {
    return { voice: overrideVoice, language: 'en-US' };
  }
  return selected;
}

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
      language: engineVoice.startsWith('bm_') ? 'en-gb' : language,
      sourceFormat: getKokoroAudioFormat()
    };
  }
  if (engineId === 'chatterbox') {
    return {
      text,
      voice: getChatterboxVoiceName(voice),
      language: null,
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
  const preparedText = prepareTtsText(text);
  if (!isSpeakableText(preparedText)) throw new Error('TTS input has no speakable text');
  const adapted = adaptNarrationForEngine(adapter.id, preparedText, narration, padEndMs);
  const synthesis = synthesisInput(adapter.id, adapted.text, language, voice);
  const outputFormat = outputFormatFromPath(outputPath);
  const gainDb = masteringGainForEngine(adapter.id);
  const masteringArgs = buildMasteringArgs({
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
  return {
    fingerprint,
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
