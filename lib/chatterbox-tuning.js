const { createEngineProfile } = require('./tts-engine-profile');

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
    suffix: (options) => `ref${String(options.refVersion || process.env.CHATTERBOX_REF_VERSION || 'brick-scott-20260707')}`
  }
});

module.exports = {
  PROFILES,
  isChatterboxVoice: engine.isVoice,
  getChatterboxVoiceName: engine.getVoiceName,
  normalizeChatterboxProfile: engine.normalizeProfile,
  getChatterboxProfileConfig: engine.getProfileConfig,
  getChatterboxChunkSize: engine.getChunkSize,
  getChatterboxVariantKey: engine.getVariantKey,
  getChatterboxConcurrency: engine.getConcurrency,
  resolveChatterboxImplementation
};
