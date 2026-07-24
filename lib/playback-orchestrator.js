/**
 * Owns playback policy across every HTTP representation: tier selection,
 * generation/resume, seeking priority, chapter assembly, and look-ahead.
 * Route handlers should only validate HTTP input and project/send the result.
 */
function createPlaybackOrchestrator(deps) {
  function tierQuery(selected) {
    if (selected.requestedTier === 'premium') return '?tier=premium';
    return selected.tier === 'instant' ? '?tier=instant' : '';
  }

  function normalizeRequestedTier(value) {
    if (!deps.isPremiumVoiceActive()) return null;
    return value === 'instant' || value === 'premium' ? value : null;
  }

  function legacyChunkRedirect(filename) {
    const match = String(filename || '').match(
      /^([A-Za-z0-9][A-Za-z0-9_-]{0,127}?)(?:_tts[a-f0-9]{10})?_ch(\d+)_chunk(\d+)\.(?:mp3|wav)$/
    );
    if (!match) return null;
    const chapterIndex = Number(match[2]);
    const chunkIndex = Number(match[3]);
    if (!Number.isSafeInteger(chapterIndex) || !Number.isSafeInteger(chunkIndex)) return null;
    // The old filename encodes only a variant hash, not a stable tier. Route
    // through canonical access so current tier/status policy is re-evaluated.
    return `/api/chunks/${encodeURIComponent(match[1])}/${chapterIndex}/${chunkIndex}`;
  }

  async function resolveTier(bookId, chapterIndex, requestedTier = null) {
    const requested = normalizeRequestedTier(requestedTier);
    if (!deps.isPremiumVoiceActive()) {
      return { tier: 'active', servedTier: null, requestedTier: null };
    }

    deps.kickPremiumPrep(bookId, chapterIndex);
    if (requested === 'instant') {
      deps.startProviderForVoice(deps.activeInstantVoice());
      return { tier: 'instant', servedTier: 'instant', requestedTier: requested };
    }
    if (requested === 'premium') {
      return { tier: 'active', servedTier: 'premium', requestedTier: requested };
    }
    if (await deps.premiumChapterReady(bookId, chapterIndex)) {
      return { tier: 'active', servedTier: 'premium', requestedTier: null };
    }

    deps.startProviderForVoice(deps.activeInstantVoice());
    return { tier: 'instant', servedTier: 'instant', requestedTier: null };
  }

  async function tierContext(bookId, chapterIndex, requestedTier = null) {
    const resolution = await resolveTier(bookId, chapterIndex, requestedTier);
    return {
      ...resolution,
      tts: deps.ttsForTier(resolution.tier),
      voice: deps.voiceForTier(resolution.tier)
    };
  }

  async function prepareManifest({
    bookId,
    chapterIndex,
    text,
    language = 'en',
    requestedTier = null,
    targetChunk = 0,
    priority = 'immediate'
  }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    let manifest = selected.tts.getChapterManifest(bookId, chapterIndex);

    if (!manifest || deps.manifestNeedsResume(manifest)) {
      manifest = await selected.tts.generateChapter(bookId, chapterIndex, text, language, priority, {
        priorityForChunk: deps.generationPriority(targetChunk),
        voice: selected.voice
      });
    } else {
      selected.tts.prioritizeChunk(bookId, chapterIndex, targetChunk, 'immediate');
      selected.tts.prioritizeChunk(bookId, chapterIndex, targetChunk + 1, 'next');
    }

    return { ...selected, manifest };
  }

  function generateLookAhead({ bookId, chapterIndex, context, selected, warmRemainder = false }) {
    const nextIndex = chapterIndex + 1;
    if (nextIndex < context.chapters.length) {
      const nextManifest = selected.tts.getChapterManifest(bookId, nextIndex);
      if (!nextManifest || deps.manifestNeedsResume(nextManifest)) {
        selected.tts.generateChapter(
          bookId,
          nextIndex,
          context.chapters[nextIndex].text,
          context.book.language || 'en',
          'background',
          { priorityForChunk: () => 'background', voice: selected.voice }
        ).catch(error => deps.onBackgroundError?.(error, { bookId, chapterIndex: nextIndex }));
      }
    }
    if (warmRemainder && nextIndex + 1 < context.chapters.length) {
      deps.warmRemainingChapters?.({
        bookId,
        chapters: context.chapters,
        startChapterIndex: nextIndex + 1,
        language: context.book.language || 'en',
        tier: selected.tier,
        voice: selected.voice
      });
    }
  }

  async function preparePlayback({ bookId, chapterIndex, requestedTier = null, targetChunk = 0 }) {
    const context = await deps.getChapterContext(bookId, chapterIndex);
    const selected = await prepareManifest({
      bookId,
      chapterIndex,
      text: context.chapter.text,
      language: context.book.language || 'en',
      requestedTier,
      targetChunk,
      priority: 'immediate'
    });
    const query = tierQuery(selected);
    generateLookAhead({ bookId, chapterIndex, context, selected });

    return {
      bookId,
      chapterIndex,
      totalChunks: selected.manifest.totalChunks,
      textLength: selected.manifest.textLength,
      servedTier: selected.servedTier || undefined,
      chunks: selected.manifest.chunks.map(chunk => ({
        index: chunk.index,
        status: chunk.status,
        textLength: chunk.textLength,
        duration: chunk.duration,
        url: `/api/chunks/${bookId}/${chapterIndex}/${chunk.index}${query}`
      }))
    };
  }

  async function prepareFirstChunk({ bookId, chapterIndex, requestedTier = null }) {
    const context = await deps.getChapterContext(bookId, chapterIndex);
    const selected = await prepareManifest({
      bookId,
      chapterIndex,
      text: context.chapter.text,
      language: context.book.language || 'en',
      requestedTier,
      targetChunk: 0,
      priority: 'immediate'
    });
    const first = selected.manifest.chunks[0];
    if (first?.jobId && deps.waitForJob) await deps.waitForJob(first.jobId);
    generateLookAhead({ bookId, chapterIndex, context, selected });
    const query = tierQuery(selected);
    return {
      ready: first?.status === 'ready',
      firstChunk: first ? `/api/chunks/${bookId}/${chapterIndex}/0${query}` : null,
      totalChunks: selected.manifest.totalChunks,
      servedTier: selected.servedTier || undefined
    };
  }

  async function prepareCurrentChapter({ bookId, chapterIndex, requestedTier = null, targetChunk = 0 }) {
    const context = await deps.getChapterContext(bookId, chapterIndex);
    const requestedTarget = Math.max(0, targetChunk);
    const selected = await prepareManifest({
      bookId,
      chapterIndex,
      text: context.chapter.text,
      language: context.book.language || 'en',
      requestedTier,
      targetChunk: requestedTarget,
      priority: 'immediate'
    });
    const boundedTarget = Math.min(requestedTarget, Math.max(0, selected.manifest.totalChunks - 1));
    if (boundedTarget !== requestedTarget) {
      selected.tts.prioritizeChunk(bookId, chapterIndex, boundedTarget, 'immediate');
    }
    generateLookAhead({ bookId, chapterIndex, context, selected, warmRemainder: true });
    return {
      success: true,
      bookId,
      chapterIndex,
      targetChunk: boundedTarget,
      servedTier: selected.servedTier || undefined,
      totalChunks: selected.manifest.totalChunks,
      readyChunks: selected.manifest.chunks.filter(chunk => chunk.status === 'ready').length,
      targetStatus: selected.manifest.chunks[boundedTarget]?.status || 'pending'
    };
  }

  async function prepareChapterAudio({
    bookId,
    chapterIndex,
    requestedTier = null,
    clean = false,
    priority = 'immediate'
  }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    const audioPath = await deps.ensureChapterAudio(bookId, chapterIndex, {
      clean,
      priority,
      tier: selected.tier
    });
    deps.prefetchNextChapter?.(bookId, chapterIndex, selected.tier);
    return { ...selected, path: audioPath };
  }

  async function chapterAudioStatus({ bookId, chapterIndex, requestedTier = null, clean = false }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    const status = await deps.inspectChapterAudio(bookId, chapterIndex, { clean, tier: selected.tier });
    return decorateAudioStatus(status, selected, bookId, chapterIndex);
  }

  async function decorateAudioStatus(status, selected, bookId, chapterIndex) {
    const result = {
      ...status,
      tier: selected.tier,
      servedTier: selected.servedTier || undefined
    };
    if (result.url) result.url += tierQuery(selected);
    if (deps.isPremiumVoiceActive()) {
      result.premiumReady = await deps.premiumChapterReady(bookId, chapterIndex);
      result.instantVoice = deps.activeInstantVoice();
    }
    return result;
  }

  async function startChapterAudio({ bookId, chapterIndex, requestedTier = null, clean = false }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    deps.ensureChapterAudio(bookId, chapterIndex, {
      clean,
      priority: 'background',
      tier: selected.tier
    }).catch(error => deps.onBackgroundError?.(error, { bookId, chapterIndex }));
    const status = await deps.inspectChapterAudio(bookId, chapterIndex, { clean, tier: selected.tier });
    return decorateAudioStatus(status, selected, bookId, chapterIndex);
  }

  async function chunkStatus({ bookId, chapterIndex, requestedTier = null }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    let manifest = selected.tts.getChapterManifest(bookId, chapterIndex);
    if (!manifest) {
      const context = await deps.getChapterContext(bookId, chapterIndex);
      manifest = await selected.tts.reconstructChapterManifest(
        bookId,
        chapterIndex,
        context.chapter.text,
        context.book.language || 'en'
      );
    }
    const readyChunks = manifest.chunks.filter(chunk => chunk.status === 'ready').length;
    const errorChunks = manifest.chunks.filter(chunk => chunk.status === 'error').length;
    const totalChunks = manifest.totalChunks;
    const status = errorChunks > 0
      ? 'error'
      : readyChunks === totalChunks
        ? 'ready'
        : manifest.chunks.some(chunk => chunk.status === 'queued' || chunk.status === 'generating')
          ? 'generating'
          : 'pending';
    const result = {
      totalChunks,
      readyChunks,
      errorChunks,
      status,
      servedTier: selected.servedTier || undefined
    };
    if (deps.isPremiumVoiceActive()) {
      result.premiumReady = await deps.premiumChapterReady(bookId, chapterIndex);
    }
    return result;
  }

  async function prioritizeChunk({ bookId, chapterIndex, chunkIndex, requestedTier = null }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    const manifest = selected.tts.getChapterManifest(bookId, chapterIndex);
    const chunk = manifest?.chunks?.[chunkIndex];
    if (!chunk) return null;
    return {
      success: true,
      prioritized: selected.tts.prioritizeChunk(bookId, chapterIndex, chunkIndex, 'immediate'),
      status: chunk.status,
      servedTier: selected.servedTier || undefined
    };
  }

  async function chunkAccess({ bookId, chapterIndex, chunkIndex, requestedTier = null }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    const manifest = selected.tts.getChapterManifest(bookId, chapterIndex);
    return {
      ...selected,
      path: selected.tts.chunkPath(bookId, chapterIndex, chunkIndex),
      status: manifest?.chunks?.[chunkIndex]?.status || 'missing'
    };
  }

  return {
    normalizeRequestedTier,
    legacyChunkRedirect,
    resolveTier,
    prepareManifest,
    preparePlayback,
    prepareFirstChunk,
    prepareCurrentChapter,
    prepareChapterAudio,
    chapterAudioStatus,
    startChapterAudio,
    chunkStatus,
    prioritizeChunk,
    chunkAccess
  };
}

module.exports = { createPlaybackOrchestrator };
