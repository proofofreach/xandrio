const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createEngineProfile, configuredGainDb } = require('./tts-engine-profile');
const { masteringGainForEngine } = require('./audio-quality');

/**
 * Sampling defaults of each Chatterbox server implementation, mirrored from
 * m4-server/chatterbox-mlx-server.py, chatterbox-server.py (Turbo/PyTorch) and
 * chatterbox-v3-server.py. The Python servers remain the source of truth and
 * report their effective values in /health `generation`; this table only lets
 * the variant key tell "operator override" from "the default the cache was
 * built with", so a CHATTERBOX_* sampling env var that merely restates the
 * default leaves every existing key untouched.
 */
const SAMPLING_DEFAULTS = Object.freeze({
  mlx: Object.freeze({ temperature: 0.65, top_p: 0.95, exaggeration: 0.5, cfg_weight: 0.5, repetition_penalty: 1.2 }),
  pytorch: Object.freeze({ temperature: 0.76, top_p: 0.95, exaggeration: 0.0, cfg_weight: 0.0, repetition_penalty: 1.18 }),
  v3: Object.freeze({ temperature: 0.7, top_p: 0.95, exaggeration: 0.35, cfg_weight: 0.3, repetition_penalty: 1.2, min_p: 0.05 }),
  'v3-mlx': Object.freeze({ temperature: 0.7, top_p: 0.95, exaggeration: 0.35, cfg_weight: 0.3, repetition_penalty: 1.2, min_p: 0.05 })
});
const SAMPLING_ENV = Object.freeze([
  ['temp', 'CHATTERBOX_TEMPERATURE', 'temperature'],
  ['topp', 'CHATTERBOX_TOP_P', 'top_p'],
  ['exag', 'CHATTERBOX_EXAGGERATION', 'exaggeration'],
  ['cfg', 'CHATTERBOX_CFG_WEIGHT', 'cfg_weight'],
  ['rep', 'CHATTERBOX_REPETITION_PENALTY', 'repetition_penalty'],
  ['minp', 'CHATTERBOX_MIN_P', 'min_p']
]);

function configuredNumber(name, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Keys the server accepts from a voice-references/<voice>.json sidecar (mirrors _voice_tuning). */
const VOICE_TUNING_KEYS = Object.freeze([
  'temperature', 'top_p', 'repetition_penalty', 'exaggeration', 'cfg_weight', 'pitch_semitones', 'tempo', 'seed'
]);

function defaultVoiceDir() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  return path.resolve(process.env.CHATTERBOX_VOICE_DIR || path.join(dataDir, 'voice-references'));
}

// Sidecar identities are read synchronously on the recipe path, so cache them
// per file identity and re-stat at most every few seconds.
const VOICE_TUNING_RECHECK_MS = 3000;
const voiceTuningCache = new Map();

/**
 * Identity of the operator-owned per-voice generation sidecar
 * (voice-references/<voice>.json, read by the Chatterbox servers' _voice_tuning):
 * a short hash of the accepted keys, or null when there is no usable sidecar.
 *
 * This is deliberately NOT part of the variant key: voices with a sidecar
 * today would otherwise change key and regenerate. It travels on verified
 * artifact markers instead and is compared only when the marker carries it
 * (see NarrationArtifactCache), so existing audio stays valid while a future
 * sidecar edit invalidates the audio generated under the old one.
 */
function getChatterboxVoiceTuningIdentity(voiceId, { voiceDir = defaultVoiceDir(), now = Date.now() } = {}) {
  const voice = engine.getVoiceName(voiceId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!voice) return null;
  const sidecarPath = path.join(voiceDir, `${voice}.json`);
  const cached = voiceTuningCache.get(sidecarPath);
  if (cached && now >= cached.checkedAt && now - cached.checkedAt < VOICE_TUNING_RECHECK_MS) return cached.identity;
  let stat = null;
  try {
    stat = fs.statSync(sidecarPath);
  } catch {
    voiceTuningCache.set(sidecarPath, { checkedAt: now, identity: null, fileKey: null });
    return null;
  }
  const fileKey = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (cached && cached.fileKey === fileKey) {
    cached.checkedAt = now;
    return cached.identity;
  }
  let identity = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const accepted = {};
      for (const key of VOICE_TUNING_KEYS) if (parsed[key] !== undefined) accepted[key] = parsed[key];
      if (Object.keys(accepted).length > 0) {
        identity = crypto.createHash('sha1').update(JSON.stringify(accepted)).digest('hex').slice(0, 16);
      }
    }
  } catch {
    identity = null;
  }
  voiceTuningCache.set(sidecarPath, { checkedAt: now, identity, fileKey });
  return identity;
}

const PROFILES = Object.freeze({
  quality: {
    name: 'quality',
    chunkSize: 220,
    maxConcurrent: 1,
    description: 'Short chunks for lowest first-play latency with Chatterbox Turbo.'
  },
  balanced: {
    name: 'balanced',
    chunkSize: 280,
    maxConcurrent: 1,
    description: 'Default Chatterbox Turbo tuning for cached audiobook playback.'
  },
  fast: {
    name: 'fast',
    chunkSize: 380,
    maxConcurrent: 1,
    description: 'Longer chunks for background generation when playback can wait.'
  }
});

const VOICE_OVERRIDES = Object.freeze({
  'brick-scott': { quality: 220, balanced: 280, fast: 380 }
});

function resolveChatterboxImplementation(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const configured = String(options.engine ?? process.env.CHATTERBOX_ENGINE ?? '').toLowerCase();
  if (configured === 'v3-mlx') return 'v3-mlx';
  if (configured === 'v3') return 'v3';
  if (configured === 'pytorch') return 'pytorch';
  if (configured === 'mlx') return 'mlx';
  return platform === 'darwin' ? 'mlx' : 'pytorch';
}

const engine = createEngineProfile({
  idPrefix: 'chatterbox:',
  envPrefix: 'CHATTERBOX',
  profiles: PROFILES,
  voiceOverrides: VOICE_OVERRIDES,
  variantExtras: {
    // Original MLX, Turbo PyTorch, and Multilingual V3 produce different
    // audio, so their caches must not mix.
    prefix: options => {
      const implementation = resolveChatterboxImplementation(options);
      if (implementation === 'v3') return 'modelmultilingualv3';
      if (implementation === 'v3-mlx') return 'modelmultilingualv3mlx8bit';
      return implementation === 'pytorch' ? 'modelturbo' : 'modeloriginal8bit';
    },
    // 20260707: engine defaults moved to temp 0.65 / top_p 0.95 (blind A/B) —
    // the ref version doubles as the Chatterbox-scoped audio cache bump.
    suffix: (options) => `ref${String(options.refVersion || process.env.CHATTERBOX_REF_VERSION || 'brick-scott-20260707')}`,
    // Sampling overrides and the mastering gain change the audio but were
    // never in the key. Each appears only when it differs from the default of
    // the implementation that will serve the request (SAMPLING_DEFAULTS,
    // DEFAULT_ENGINE_GAIN_DB), so every default-configured cache keeps its key.
    identity: options => {
      const defaults = SAMPLING_DEFAULTS[resolveChatterboxImplementation(options)] || SAMPLING_DEFAULTS.mlx;
      return [
        ...SAMPLING_ENV.map(([tag, name, key]) => ({ tag, value: configuredNumber(name), defaultValue: defaults[key] })),
        { tag: 'gain', value: configuredGainDb('CHATTERBOX'), defaultValue: masteringGainForEngine('chatterbox', {}) }
      ];
    }
  }
});

module.exports = {
  PROFILES,
  SAMPLING_DEFAULTS,
  getChatterboxVoiceTuningIdentity,
  isChatterboxVoice: engine.isVoice,
  getChatterboxVoiceName: engine.getVoiceName,
  normalizeChatterboxProfile: engine.normalizeProfile,
  getChatterboxProfileConfig: engine.getProfileConfig,
  getChatterboxChunkSize: engine.getChunkSize,
  getChatterboxSplitPolicy: engine.getSplitPolicy,
  getChatterboxVariantKey: engine.getVariantKey,
  getChatterboxConcurrency: engine.getConcurrency,
  resolveChatterboxImplementation
};
