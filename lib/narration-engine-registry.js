const { createEngineAdapterRegistry } = require('./tts-engine-adapters');

/**
 * Registry for narration-engine behavior that callers previously reproduced
 * with voice-prefix conditionals. Generation remains behind TTSQueue; this
 * module owns engine identity, tuning, cache identity, and concurrency policy.
 */
function createNarrationEngineRegistry(options = {}) {
  const defaultChunkSize = options.defaultChunkSize || 4000;
  const defaultConcurrency = options.defaultConcurrency || 2;
  const chatterboxRefVersion = options.chatterboxRefVersion || (() => null);

  const adapterRegistry = createEngineAdapterRegistry({
    defaultChunkSize,
    defaultConcurrency,
    chatterboxRefVersion,
    platform: options.platform,
    chatterboxEngine: options.chatterboxEngine,
    lifecycleBindings: options.lifecycleBindings
  });

  function forVoice(voice) {
    const resolved = String(voice || '');
    const adapter = adapterRegistry.resolve(resolved);
    return {
      id: adapter.id,
      voice: resolved,
      capabilities: { ...(adapter.capabilities || {}) },
      profile: adapter.profile(resolved),
      chunkSize: adapter.chunkSize(resolved),
      concurrency: adapter.concurrency(resolved),
      variantKey: adapter.variantKey(resolved),
      supervised: Boolean(adapter.lifecycle.supervised),
      start: () => adapter.lifecycle.start?.(resolved),
      stop: () => adapter.lifecycle.stop?.(),
      health: () => adapter.lifecycle.health ? adapter.lifecycle.health(resolved) : Promise.resolve(true),
      processHint: () => Boolean(adapter.lifecycle.processHint?.())
    };
  }

  return {
    forVoice,
    adapters: () => adapterRegistry.ids(),
    capabilities: voice => forVoice(voice).capabilities,
    start: voice => forVoice(voice).start(),
    health: voice => forVoice(voice).health(),
    processHint: voice => forVoice(voice).processHint(),
    validateRecordedVariant: ({ voice, variantKey, availableVoiceIds = null }) => {
      if (typeof voice !== 'string' || !voice) {
        return { compatible: false, error: 'Recovery record has no voice identity' };
      }
      if (Array.isArray(availableVoiceIds) && !availableVoiceIds.includes(voice)) {
        return { compatible: false, error: `Recovery voice is unavailable: ${voice}` };
      }
      const expectedVariant = forVoice(voice).variantKey;
      return variantKey === expectedVariant
        ? { compatible: true, expectedVariant }
        : {
            compatible: false,
            expectedVariant,
            error: 'Recorded voice implementation or reference version does not match the current provider'
          };
    },
    stopAll: () => adapterRegistry.forEach(adapter => adapter.lifecycle.stop?.())
  };
}

module.exports = { createNarrationEngineRegistry };
