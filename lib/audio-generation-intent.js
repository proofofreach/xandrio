const GENERATION_ORIGIN = Object.freeze({
  PLAYBACK_CURRENT: 'playback-current',
  PLAYBACK_LOOKAHEAD: 'playback-lookahead',
  OFFLINE_DOWNLOAD: 'offline-download',
  IMPORT_WARMUP: 'import-warmup',
  VOICE_REFRESH: 'voice-refresh',
  PREMIUM_PREP: 'premium-prep'
});

const GENERATION_PRIORITY = Object.freeze({
  IMMEDIATE: 'immediate',
  NEXT: 'next',
  LOOKAHEAD: 'lookahead',
  DOWNLOAD: 'download',
  BACKGROUND: 'background'
});

const TRANSIENT_GENERATION_ORIGINS = Object.freeze([
  GENERATION_ORIGIN.PLAYBACK_CURRENT,
  GENERATION_ORIGIN.PLAYBACK_LOOKAHEAD,
  GENERATION_ORIGIN.IMPORT_WARMUP,
  GENERATION_ORIGIN.VOICE_REFRESH
]);

function chapterGenerationScope({ origin, priority, completeChapter = false }) {
  const complete = Boolean(completeChapter);
  return {
    chunkIndexes: origin === GENERATION_ORIGIN.PLAYBACK_CURRENT && !complete
      ? [0, 1]
      : null,
    uniformPriority: complete || [
      GENERATION_PRIORITY.BACKGROUND,
      GENERATION_PRIORITY.DOWNLOAD,
      GENERATION_PRIORITY.LOOKAHEAD
    ].includes(priority)
  };
}

module.exports = {
  chapterGenerationScope,
  GENERATION_ORIGIN,
  GENERATION_PRIORITY,
  TRANSIENT_GENERATION_ORIGINS
};
