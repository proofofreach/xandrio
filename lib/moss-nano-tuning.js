const { sources } = require('../moss-nano/models.lock.json');
const voices = require('../moss-nano/voices.json');
const { getMasteringBitrate } = require('./audio-quality');
const calibration = require('../moss-nano/calibration.json');
const { getTtsOutputFormatForVoice } = require('./tts-output-format');
const { AUDIO_PIPELINE_VERSION, NARRATION_PREP_VERSION, getParagraphPauseMs } = require('./tts-engine-profile');

const RENDER_REVISION = 'stream8-fixed-seed1234-mono-limit-v2';
// Keep this historical cache namespace: the default seed, text and mastering
// are unchanged. Recovery only extends previously rejected synthesis; changing
// the variant would discard verified audio and quarantine durable book jobs.
const RECOVERY_POLICY = 'validated-seed-retry-v2';
const RECOVERY_SEEDS = Object.freeze([1234, 1235, 1236]);
const enabled = (env = process.env) => env.MOSS_NANO_ENABLED === 'true';
const isMossNanoVoice = voice => typeof voice === 'string' && voice.startsWith('moss-nano:');
const getMossNanoVoiceName = voice => String(voice || '').slice('moss-nano:'.length);
const baseUrl = (env = process.env) => (env.MOSS_NANO_TTS_URL || 'http://127.0.0.1:8768').replace(/\/+$/, '');
const synthesisIdentity = Object.freeze({
  model: sources.model_revisions['MOSS-TTS-Nano-100M-ONNX'],
  codec: sources.model_revisions['MOSS-Audio-Tokenizer-Nano-ONNX'],
  runtime: sources.runtime_commit,
  render: RENDER_REVISION
});

function variantKey(voice) {
  return `${voice}:model${synthesisIdentity.model}:codec${synthesisIdentity.codec}:runtime${synthesisIdentity.runtime}:render${RENDER_REVISION}:splitparagraph1:chunk160:out${getTtsOutputFormatForVoice(voice)}:gain${masteringGain(voice)}:pause${getParagraphPauseMs()}:prep${NARRATION_PREP_VERSION}:audio${AUDIO_PIPELINE_VERSION}:br${getMasteringBitrate()}`;
}

function masteringGain(voice) {
  const gain = calibration.voices[getMossNanoVoiceName(voice)]?.gainDb;
  if (!Number.isFinite(gain)) throw new Error('Unknown MOSS Nano voice');
  const configured = Number(process.env.MOSS_NANO_MASTERING_GAIN_DB);
  return Number.isFinite(configured) ? configured : gain;
}

module.exports = { enabled, isMossNanoVoice, getMossNanoVoiceName, baseUrl, voices, variantKey, synthesisIdentity, masteringGain,
  RECOVERY_POLICY, RECOVERY_SEEDS };
