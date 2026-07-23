function normalizeTtsOutputFormat(value, fallback = 'mp3') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'wav') return 'wav';
  if (normalized === 'mp3') return 'mp3';
  return fallback === 'wav' ? 'wav' : 'mp3';
}

function isKokoroVoiceId(voice) {
  return typeof voice === 'string' && voice.startsWith('kokoro:');
}

function isChatterboxVoiceId(voice) {
  return typeof voice === 'string' && voice.startsWith('chatterbox:');
}

function getTtsOutputFormatForVoice(voice, env = process.env) {
  const voiceId = String(voice || '');
  if (isKokoroVoiceId(voiceId)) {
    return normalizeTtsOutputFormat(
      env.KOKORO_TTS_OUTPUT_FORMAT || env.KOKORO_OUTPUT_FORMAT || env.TTS_OUTPUT_FORMAT,
      'mp3'
    );
  }
  if (isChatterboxVoiceId(voiceId)) {
    return normalizeTtsOutputFormat(
      env.CHATTERBOX_TTS_OUTPUT_FORMAT || env.CHATTERBOX_OUTPUT_FORMAT || env.TTS_OUTPUT_FORMAT,
      'mp3'
    );
  }
  return normalizeTtsOutputFormat(env.EDGE_TTS_OUTPUT_FORMAT || env.EDGE_OUTPUT_FORMAT || env.TTS_OUTPUT_FORMAT, 'mp3');
}

function outputFormatFromVariantKey(variantKey) {
  const match = String(variantKey || '').match(/:out(mp3|wav)(?::|$)/);
  return match ? match[1] : null;
}

function outputExtensionForFormat(format) {
  return normalizeTtsOutputFormat(format) === 'wav' ? 'wav' : 'mp3';
}

function outputFormatFromPath(filePath) {
  return /\.wav$/i.test(String(filePath || '')) ? 'wav' : 'mp3';
}

module.exports = {
  normalizeTtsOutputFormat,
  getTtsOutputFormatForVoice,
  outputFormatFromVariantKey,
  outputExtensionForFormat,
  outputFormatFromPath
};
