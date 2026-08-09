/**
 * Owns playback policy across every HTTP representation: tier selection,
 * generation/resume, seeking priority, chapter assembly, and look-ahead.
 * Route handlers should only validate HTTP input and project/send the result.
 */
const { MASTERING_POLICY, measureStaticNoiseProfile } = require('./audio-quality');

const {
  GENERATION_ORIGIN,
  GENERATION_PRIORITY
} = require('./audio-generation-intent');

function createPlaybackOrchestrator(deps) {
  const continuousTimelines = new Map();
  const validatedChunkPaths = new Set();
  const timelineMaxAgeMs = 12 * 60 * 60 * 1000;

  function pruneTimelines() {
    const cutoff = Date.now() - timelineMaxAgeMs;
    for (const [sessionId, timeline] of continuousTimelines) {
      if (timeline.updatedAt < cutoff) continuousTimelines.delete(sessionId);
    }
  }

  function tierQuery(selected) {
    if (selected.requestedTier === 'premium') return '?tier=premium';
    if (selected.requestedTier === 'active') return '?tier=active';
    return selected.tier === 'instant' ? '?tier=instant' : '';
  }

  function normalizeRequestedTier(value) {
    if (!deps.isPremiumVoiceActive()) return null;
    return value === 'instant' || value === 'premium' || value === 'active' ? value : null;
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

    if (requested === 'instant') {
      deps.startProviderForVoice(deps.activeInstantVoice());
      return { tier: 'instant', servedTier: 'instant', requestedTier: requested };
    }
    if (requested === 'premium' || requested === 'active') {
      return { tier: 'active', servedTier: 'premium', requestedTier: requested };
    }
    deps.kickPremiumPrep(bookId, chapterIndex);
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
    priority = 'immediate',
    origin = GENERATION_ORIGIN.PLAYBACK_CURRENT,
    selectedTier = null,
    priorityForChunk = null
  }) {
    const selected = selectedTier || await tierContext(bookId, chapterIndex, requestedTier);
    let manifest = selected.tts.getChapterManifest(bookId, chapterIndex);
    const generate = () => selected.tts.generateChapter(bookId, chapterIndex, text, language, priority, {
      priorityForChunk: priorityForChunk || deps.generationPriority(targetChunk),
      voice: selected.voice,
      origin,
      chunkIndexes: [targetChunk, targetChunk + 1]
    });

    if (!manifest || deps.manifestNeedsResume(manifest)) {
      manifest = await generate();
    } else {
      await selected.tts.claimChapter?.(bookId, chapterIndex, {
        origin
      }, GENERATION_PRIORITY.IMMEDIATE, {
        chunkIndexes: [targetChunk, targetChunk + 1]
      });
      selected.tts.prioritizeChunk(bookId, chapterIndex, targetChunk, GENERATION_PRIORITY.IMMEDIATE);
      selected.tts.prioritizeChunk(bookId, chapterIndex, targetChunk + 1, GENERATION_PRIORITY.NEXT);
    }

    const target = manifest?.chunks?.[targetChunk];
    if (target?.status === 'ready' && typeof selected.tts.invalidateCachedChunk === 'function') {
      const chunkPath = selected.tts.chunkPath(bookId, chapterIndex, targetChunk);
      if (!validatedChunkPaths.has(chunkPath)) {
        const inspect = deps.inspectStaticAudio || measureStaticNoiseProfile;
        const profile = await inspect(chunkPath);
        if (profile?.staticNoise) {
          console.warn(
            `[playback] Replacing static audio for ${bookId}:${chapterIndex}:${targetChunk} ` +
            `(spectral flatness ${profile.meanSpectralFlatness.toFixed(3)})`
          );
          await selected.tts.invalidateCachedChunk(bookId, chapterIndex, targetChunk);
          manifest = await generate();
        } else if (profile) {
          validatedChunkPaths.add(chunkPath);
          if (validatedChunkPaths.size > 100000) validatedChunkPaths.clear();
        }
      }
    }

    return { ...selected, manifest };
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
      priority: 'immediate',
      origin: GENERATION_ORIGIN.VOICE_REFRESH
    });
    const boundedTarget = Math.min(requestedTarget, Math.max(0, selected.manifest.totalChunks - 1));
    if (boundedTarget !== requestedTarget) {
      selected.tts.prioritizeChunk(bookId, chapterIndex, boundedTarget, 'immediate');
    }
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

  async function prepareAudioStreamForTier({
    bookId,
    chapterIndex,
    requestedTier = null,
    selectedTier = null,
    startOffsetSeconds = 0,
    lookAhead = true,
    assemble = true
  }) {
    const finalized = selectedTier || await tierContext(bookId, chapterIndex, requestedTier);
    const finalizedStatus = await deps.inspectChapterAudio(bookId, chapterIndex, {
      clean: false,
      tier: finalized.tier
    });
    if (finalizedStatus.ready) {
      return {
        bookId,
        chapterIndex,
        servedTier: finalized.servedTier || undefined,
        format: finalized.tts.currentOutputFormat(),
        finalPath: finalized.tts.chapterPath(bookId, chapterIndex),
        totalChunks: 0,
        startChunkIndex: 0,
        decodeStartOffsetSeconds: Math.max(0, Number(startOffsetSeconds) || 0),
        logicalStartOffsetSeconds: Math.max(0, Number(startOffsetSeconds) || 0),
        chunkStartSeconds: 0,
        waitForChunk: async () => {
          throw new Error('Finalized chapter audio disappeared before it could be served');
        },
        prioritize() {}
      };
    }

    const context = await deps.getChapterContext(bookId, chapterIndex);
    const requestedOffset = Math.max(0, Number(startOffsetSeconds) || 0);
    const existingManifest = finalized.tts.getChapterManifest(bookId, chapterIndex);
    let initialTargetChunk = 0;
    if (requestedOffset > 0 && existingManifest?.chunks?.length &&
        typeof finalized.tts.planChapterSeek === 'function') {
      initialTargetChunk = (await finalized.tts.planChapterSeek(
        bookId,
        chapterIndex,
        requestedOffset,
        context.chapter.estimatedDuration
      )).targetChunk;
    } else if (requestedOffset > 0 && context.chapter.estimatedDuration > 0 &&
        typeof finalized.tts.splitIntoChunks === 'function') {
      const estimatedChunkCount = finalized.tts.splitIntoChunks(context.chapter.text).length;
      const estimatedProgress = Math.min(
        requestedOffset / context.chapter.estimatedDuration,
        0.999999
      );
      initialTargetChunk = Math.floor(estimatedProgress * estimatedChunkCount);
    }
    const selected = await prepareManifest({
      bookId,
      chapterIndex,
      text: context.chapter.text,
      language: context.book.language || 'en',
      requestedTier,
      targetChunk: initialTargetChunk,
      priority: 'immediate',
      selectedTier: finalized
    });
    // Build the seekable artifact concurrently for subsequent Range requests.
    // The active progressive response never redirects or switches resources.
    if (assemble) {
      deps.ensureChapterAudio(bookId, chapterIndex, {
        clean: false,
        priority: 'background',
        tier: selected.tier
      }).catch(error => deps.onBackgroundError?.(error, { bookId, chapterIndex }));
    }

    const tts = selected.tts;
    const seekPlan = requestedOffset > 0 && typeof tts.planChapterSeek === 'function'
      ? await tts.planChapterSeek(
          bookId,
          chapterIndex,
          requestedOffset,
          context.chapter.estimatedDuration
        )
      : {
          targetChunk: 0,
          chunkOffsetSeconds: requestedOffset,
          chunkStartSeconds: 0,
          logicalOffsetSeconds: requestedOffset
        };
    const startChunkIndex = Math.max(
      0,
      Math.min(selected.manifest.totalChunks - 1, Number(seekPlan.targetChunk) || 0)
    );
    if (startChunkIndex > 0) {
      await tts.claimChapter?.(bookId, chapterIndex, {
        origin: GENERATION_ORIGIN.PLAYBACK_CURRENT
      }, GENERATION_PRIORITY.IMMEDIATE, {
        chunkIndexes: [startChunkIndex, startChunkIndex + 1]
      });
      tts.prioritizeChunk(bookId, chapterIndex, startChunkIndex, GENERATION_PRIORITY.IMMEDIATE);
      tts.prioritizeChunk(bookId, chapterIndex, startChunkIndex + 1, GENERATION_PRIORITY.NEXT);
    }
    const waitForChunk = (chunkIndex, signal) => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        tts.off?.('chunk:ready', onReady);
        tts.off?.('chunk:error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const matches = event => event?.bookId === bookId &&
        event?.chapterIndex === chapterIndex &&
        event?.chunkIndex === chunkIndex;
      const onReady = event => {
        if (matches(event)) finish(resolve, event.path || tts.chunkPath(bookId, chapterIndex, chunkIndex));
      };
      const onError = event => {
        if (!matches(event)) return;
        const error = new Error(`Narration chunk ${chunkIndex} failed`);
        error.cause = event.error;
        finish(reject, error);
      };
      const onAbort = () => finish(reject, Object.assign(new Error('Audio request closed'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
      }));
      const inspect = () => {
        const chunk = tts.getChapterManifest(bookId, chapterIndex)?.chunks?.[chunkIndex];
        if (chunk?.status === 'ready') {
          finish(resolve, chunk.path || tts.chunkPath(bookId, chapterIndex, chunkIndex));
        } else if (chunk?.status === 'error') {
          onError({ bookId, chapterIndex, chunkIndex });
        }
      };

      tts.on?.('chunk:ready', onReady);
      tts.on?.('chunk:error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else inspect();
    });

    return {
      bookId,
      chapterIndex,
      servedTier: selected.servedTier || undefined,
      // Progressive responses are indefinite. A finite WAV header cannot be
      // finalized on a live response, so decode either source format and use
      // one continuous MP3 transport encoder.
      format: 'mp3',
      finalPath: tts.chapterPath(bookId, chapterIndex),
      totalChunks: selected.manifest.totalChunks,
      startChunkIndex,
      decodeStartOffsetSeconds: Math.max(0, Number(seekPlan.chunkOffsetSeconds) || 0),
      logicalStartOffsetSeconds: Math.max(0, Number(seekPlan.logicalOffsetSeconds) || 0),
      chunkStartSeconds: Math.max(0, Number(seekPlan.chunkStartSeconds) || 0),
      waitForChunk,
      prioritize(chunkIndex) {
        tts.prioritizeChunk(bookId, chapterIndex, chunkIndex, 'immediate');
        tts.prioritizeChunk(bookId, chapterIndex, chunkIndex + 1, 'next');
      }
    };
  }

  async function prepareAudioStream(options) {
    return prepareAudioStreamForTier(options);
  }

  async function prepareContinuousAudioStream({
    bookId,
    chapterIndex,
    requestedTier = null,
    sessionId = null,
    startOffsetSeconds = 0,
    endChapterIndex: requestedEndChapterIndex = null
  }) {
    pruneTimelines();
    const context = await deps.getChapterContext(bookId, chapterIndex);
    const selectedTier = await tierContext(bookId, chapterIndex, requestedTier);
    const lastChapterIndex = context.chapters.length - 1;
    const endChapterIndex = Number.isInteger(requestedEndChapterIndex)
      ? Math.max(chapterIndex, Math.min(requestedEndChapterIndex, lastChapterIndex))
      : lastChapterIndex;
    const firstStream = await prepareAudioStreamForTier({
      bookId,
      chapterIndex,
      selectedTier,
      startOffsetSeconds,
      lookAhead: false,
      assemble: false
    });
    const logicalStartOffsetSeconds = Math.max(
      0,
      Number(firstStream.logicalStartOffsetSeconds) || 0
    );
    const timeline = sessionId ? {
      sessionId,
      bookId,
      startChapterIndex: chapterIndex,
      endChapterIndex,
      startOffsetSeconds: logicalStartOffsetSeconds,
      durations: new Map(),
      pendingDurations: new Map(),
      complete: false,
      updatedAt: Date.now()
    } : null;
    if (timeline && firstStream.chunkStartSeconds > 0) {
      timeline.pendingDurations.set(chapterIndex, firstStream.chunkStartSeconds);
    }
    if (timeline) continuousTimelines.set(sessionId, timeline);
    return {
      bookId,
      chapterIndex,
      endChapterIndex,
      servedTier: selectedTier.servedTier || undefined,
      format: 'mp3',
      startOffsetSeconds: timeline?.startOffsetSeconds || logicalStartOffsetSeconds,
      decodeStartOffsetSeconds: Math.max(
        0,
        Number(firstStream.decodeStartOffsetSeconds) || 0
      ),
      outputPacing: {
        burstAudioSeconds: 30,
        realtimeMultiplier: 1.5
      },
      onInputDecoded(descriptor, pcmBytes, details = {}) {
        if (!timeline || !Number.isInteger(descriptor.chapterIndex)) return;
        const seconds = (
          Math.max(0, Number(pcmBytes) || 0)
          + Math.max(0, Number(details.skippedPcmBytes) || 0)
        )
          / (MASTERING_POLICY.sampleRate * MASTERING_POLICY.channels * 2);
        const accumulated = (timeline.pendingDurations.get(descriptor.chapterIndex) || 0) + seconds;
        timeline.pendingDurations.set(descriptor.chapterIndex, accumulated);
        if (descriptor.lastInChapter) {
          timeline.durations.set(
            descriptor.chapterIndex,
            accumulated
          );
          timeline.pendingDurations.delete(descriptor.chapterIndex);
          if (descriptor.chapterIndex === timeline.endChapterIndex) timeline.complete = true;
        }
        timeline.updatedAt = Date.now();
      },
      async *iterateInputs(signal) {
        let currentPromise = Promise.resolve(firstStream);
        for (let index = chapterIndex; index <= endChapterIndex; index++) {
          const current = await currentPromise;
          if (current.totalChunks === 0) {
            yield {
              path: current.finalPath,
              chapterIndex: index,
              lastInChapter: true
            };
          } else {
            const firstChunkIndex = index === chapterIndex
              ? Math.max(0, Number(current.startChunkIndex) || 0)
              : 0;
            for (let chunkIndex = firstChunkIndex; chunkIndex < current.totalChunks; chunkIndex++) {
              current.prioritize(chunkIndex);
              yield {
                path: await current.waitForChunk(chunkIndex, signal),
                chapterIndex: index,
                lastInChapter: chunkIndex === current.totalChunks - 1
              };
            }
          }

          if (index >= endChapterIndex) break;
          currentPromise = prepareAudioStreamForTier({
            bookId,
            chapterIndex: index + 1,
            selectedTier,
            lookAhead: false,
            assemble: false
          });
        }
      }
    };
  }

  function continuousTimeline(sessionId) {
    pruneTimelines();
    const timeline = continuousTimelines.get(sessionId);
    if (!timeline) return null;
    const durations = Array.from(
      { length: timeline.endChapterIndex - timeline.startChapterIndex + 1 },
      (_value, index) => timeline.durations.get(timeline.startChapterIndex + index) || null
    );
    return {
      sessionId,
      bookId: timeline.bookId,
      startChapterIndex: timeline.startChapterIndex,
      startOffsetSeconds: timeline.startOffsetSeconds,
      durations,
      complete: timeline.complete,
      updatedAt: timeline.updatedAt
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

  async function startChapterAudio({
    bookId,
    chapterIndex,
    requestedTier = null,
    clean = false,
    priority = 'background',
    completeChapter = false
  }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    const generationPriority = priority === 'download'
      ? 'download'
      : priority === 'immediate'
        ? 'immediate'
        : 'background';
    deps.ensureChapterAudio(bookId, chapterIndex, {
      clean,
      priority: generationPriority,
      completeChapter,
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
    await selected.tts.claimChapter?.(bookId, chapterIndex, {
      origin: GENERATION_ORIGIN.PLAYBACK_CURRENT
    }, GENERATION_PRIORITY.IMMEDIATE, {
      chunkIndexes: [chunkIndex, chunkIndex + 1]
    });
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
    prepareAudioStream,
    prepareContinuousAudioStream,
    continuousTimeline,
    prepareChapterAudio,
    chapterAudioStatus,
    startChapterAudio,
    chunkStatus,
    prioritizeChunk,
    chunkAccess
  };
}

module.exports = { createPlaybackOrchestrator };
