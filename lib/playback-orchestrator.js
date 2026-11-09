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
const {
  PLAYBACK_STARTUP_CHUNKS,
  nextChunkArrivesInTime,
  playbackBufferIndexes
} = require('./playback-runway');
const {
  CHAPTER_UNSPEAKABLE,
  isPlayableChapter,
  findPlayableChapterIndex,
  isUnspeakableChapterError,
  chapterUnspeakableError
} = require('./chapter-playability');
const { chapterStructureKey } = require('./chapter-structure');

// A continuous transport that reports its lead (HLS) is this many seconds of
// encoded audio past what the listener has fetched. A chunk needed beyond it
// is look-ahead work, not foreground work; it is promoted once the listener
// comes within this distance while it is still pending.
const FOREGROUND_LEAD_SECONDS = 120;

// ChunkedTTS bumps a chapter's text epoch whenever its narration text can
// change under an existing plan (pronunciation repair, rebuild, metadata
// refresh), and a book epoch when all of its generation is cancelled.
const chapterTextEpoch = (tts, bookId, chapterIndex) => tts?._chapterTextEpoch?.(bookId, chapterIndex) ?? 0;
const bookEpoch = (tts, bookId) => tts?._bookEpoch?.(bookId) ?? 0;

// A stream's chunk indexes mean something only for the plan it was prepared
// under. A resumed generation installs a new manifest object for the same
// plan, so object identity is too strict; a re-chunk keeps the chapter but
// changes what every index refers to.
function chunkPlanIdentity(epochs, manifest) {
  return JSON.stringify([
    epochs.text,
    epochs.book,
    manifest?.variantKey || '',
    manifest?.totalChunks ?? null,
    manifest?.textLength ?? null
  ]);
}

// Both are terminal for the live response: the HLS player gets 410 on its next
// poll and the continuous player's reconnect is refused, so either reloads at
// its own position against the current book.
function chunkPlanChangedError(chunkIndex) {
  return Object.assign(new Error(`Narration chunk ${chunkIndex} was re-planned under this stream`), {
    statusCode: 410,
    code: 'CHUNK_PLAN_CHANGED'
  });
}

function chapterStructureChangedError() {
  return Object.assign(new Error('The book\'s chapters changed under this stream; reload at the current position'), {
    statusCode: 410,
    code: 'CHAPTER_STRUCTURE_CHANGED'
  });
}

function createPlaybackOrchestrator(deps) {
  const continuousTimelines = new Map();
  // timeline key -> token of the newest prepare, so only it may register.
  const timelinePrepares = new Map();
  const validatedChunkPaths = new Set();
  const timelineMaxAgeMs = 12 * 60 * 60 * 1000;
  // A session id is chosen by the client, so it names a timeline only within
  // the owner (account or browser session) that created it.
  const timelineKey = (ownerKey, sessionId) => sessionId ? JSON.stringify([ownerKey || '', sessionId]) : null;

  function pruneTimelines() {
    const cutoff = Date.now() - timelineMaxAgeMs;
    for (const [key, timeline] of continuousTimelines) {
      if (timeline.updatedAt < cutoff) continuousTimelines.delete(key);
    }
    for (const [key, token] of timelinePrepares) {
      if (token.startedAt < cutoff) timelinePrepares.delete(key);
    }
  }

  const fixedOptions = selected => selected.actualVoiceId ? { tts: selected.tts, voice: selected.voice } : {};

  // A chapter without narration is a property of the book, not a failure.
  // Every representation reports it with this one typed, terminal result so
  // the client can move on to the next playable chapter instead of retrying.
  function unplayableChapterStatus(bookId, chapterIndex, chapters = []) {
    return {
      ready: false,
      status: 'unplayable',
      code: CHAPTER_UNSPEAKABLE,
      retryable: false,
      bookId,
      chapterIndex,
      totalChunks: 0,
      readyChunks: 0,
      errorChunks: 0,
      nextPlayableChapterIndex: findPlayableChapterIndex(chapters, chapterIndex, 1)
    };
  }

  function unplayableChapterError(status) {
    return Object.assign(chapterUnspeakableError(), {
      statusCode: 422,
      retryable: false,
      chapterIndex: status.chapterIndex,
      nextPlayableChapterIndex: status.nextPlayableChapterIndex
    });
  }

  // Structural check before any tier, provider or generation work starts.
  async function structurallyUnplayable(bookId, chapterIndex, context = null) {
    const resolved = context || await deps.getChapterContext(bookId, chapterIndex);
    if (isPlayableChapter(resolved?.chapter)) return null;
    return unplayableChapterStatus(bookId, chapterIndex, resolved?.chapters);
  }

  async function unplayableFromError(error, bookId, chapterIndex, context = null) {
    if (!isUnspeakableChapterError(error)) throw error;
    const resolved = context || await deps.getChapterContext(bookId, chapterIndex);
    return unplayableChapterStatus(bookId, chapterIndex, resolved?.chapters);
  }

  function tierQuery(selected) {
    if (selected.actualVoiceId) return `?tier=${selected.servedTier || 'active'}&voiceId=${encodeURIComponent(selected.actualVoiceId)}`;
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
    if (deps.resolveNarrationContext) return deps.resolveNarrationContext(bookId, chapterIndex, requestedTier);
    const requested = normalizeRequestedTier(requestedTier);
    if (!deps.isPremiumVoiceActive()) {
      return { tier: 'active', servedTier: null, requestedTier: null };
    }

    // An operator may enable only a prepared engine, or offer no instant
    // voice for its language. Do not label slow synthesis as instant audio.
    if (!deps.activeInstantVoice()) {
      deps.kickPremiumPrep(bookId, chapterIndex);
      return { tier: 'active', servedTier: 'premium', requestedTier: requested };
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
      tts: resolution.tts || deps.ttsForTier(resolution.tier),
      voice: resolution.voice || deps.voiceForTier(resolution.tier)
    };
  }

  async function playbackTargetChunk(tts, bookId, chapterIndex, offset, chapter) {
    if (!(offset > 0)) return 0;
    if (tts.getChapterManifest(bookId, chapterIndex)?.chunks?.length &&
        typeof tts.planChapterSeek === 'function') {
      return (await tts.planChapterSeek(bookId, chapterIndex, offset, chapter.estimatedDuration)).targetChunk;
    }
    if (chapter.estimatedDuration > 0 && typeof tts.planChunks === 'function') {
      const chunkCount = (await tts.planChunks(chapter.text)).length;
      return Math.floor(Math.min(offset / chapter.estimatedDuration, 0.999999) * chunkCount);
    }
    return 0;
  }

  // Keep the playback buffer after `fromIndex` ahead of every look-ahead.
  // Never lowers a priority: the queue ignores demotions.
  function prioritizePlaybackBuffer(tts, bookId, chapterIndex, fromIndex) {
    const chunks = tts.getChapterManifest(bookId, chapterIndex)?.chunks;
    for (const index of playbackBufferIndexes(chunks, fromIndex).slice(1)) {
      if (chunks[index]?.status !== 'ready') tts.prioritizeChunk(bookId, chapterIndex, index, GENERATION_PRIORITY.NEXT);
    }
  }

  async function withPlaybackRunway(status, selected, bookId, chapterIndex, startOffsetSeconds, playbackRate = null) {
    if (startOffsetSeconds === null) return status;
    const manifest = selected.tts.getChapterManifest(bookId, chapterIndex);
    let targetChunk = 0;
    if (startOffsetSeconds > 0 && manifest?.chunks?.length) {
      const { chapter } = await deps.getChapterContext(bookId, chapterIndex);
      targetChunk = await playbackTargetChunk(selected.tts, bookId, chapterIndex, startOffsetSeconds, chapter);
    }
    const window = (manifest?.chunks || []).slice(targetChunk, targetChunk + PLAYBACK_STARTUP_CHUNKS);
    let readyChunks = 0;
    for (const chunk of window) {
      if (chunk.status !== 'ready') break;
      readyChunks++;
    }
    const runwayEarlyStart = readyChunks === 1 && window.length === 2 &&
      await earlyStartGranted(selected.tts, manifest, targetChunk, window, playbackRate);
    return {
      ...status,
      targetChunk,
      runwayRequiredChunks: window.length,
      runwayReadyChunks: readyChunks,
      runwayEarlyStart,
      runwayBlocked: Boolean(manifest?._generation?.halted && window.some(chunk => chunk.status === 'pending')),
      runwayErrorChunks: window.filter(chunk => chunk.status === 'error').length
    };
  }

  async function earlyStartGranted(tts, manifest, targetChunk, [ready, next], playbackRate) {
    // A grant is sticky for the manifest: the status poll and the media
    // request that follows it (and every live-playlist reload) must agree,
    // even as the time-based estimate moves. Errors still fail the gate.
    if (manifest._runwayGrants?.has(targetChunk)) return true;
    if (typeof tts.chunkGenerationTiming !== 'function' ||
        typeof tts.readyChunkDurationSeconds !== 'function') {
      return false;
    }
    const readyTiming = tts.chunkGenerationTiming(ready);
    const nextTiming = tts.chunkGenerationTiming(next);
    if (!readyTiming?.synthesisMs || !nextTiming) return false;
    const granted = nextChunkArrivesInTime({
      ready,
      next,
      readyTiming,
      nextTiming,
      readyDurationSeconds: await tts.readyChunkDurationSeconds(ready),
      now: Date.now(),
      playbackRate
    });
    if (granted) {
      if (!manifest._runwayGrants) {
        Object.defineProperty(manifest, '_runwayGrants', {
          value: new Set(),
          configurable: true
        });
      }
      manifest._runwayGrants.add(targetChunk);
    }
    return granted;
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
      prioritizePlaybackBuffer(selected.tts, bookId, chapterIndex, targetChunk);
    }

    const target = manifest?.chunks?.[targetChunk];
    if (target?.status === 'ready' && typeof selected.tts.invalidateCachedChunk === 'function') {
      const chunkPath = selected.tts.chunkPath(bookId, chapterIndex, targetChunk);
      // Freshly generated chunks were analyzed by the queue already; decoding
      // them again here only delays the stream's first byte.
      if (!validatedChunkPaths.has(chunkPath) &&
          !(await selected.tts.chunkAudioValidated?.(chunkPath))) {
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
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
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
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
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
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
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
    assemble = true,
    // A caller that already resolved the chapter (a continuous stream's
    // structure check) passes it, so both read the same chapter list.
    context: resolvedContext = null
  }) {
    const context = resolvedContext || await deps.getChapterContext(bookId, chapterIndex);
    const unplayable = await structurallyUnplayable(bookId, chapterIndex, context);
    if (unplayable) throw unplayableChapterError(unplayable);
    const finalized = selectedTier || await tierContext(bookId, chapterIndex, requestedTier);
    // Read before any plan is chosen: a bump during preparation then retires
    // this stream instead of letting it adopt the re-planned chapter.
    const epochs = {
      text: chapterTextEpoch(finalized.tts, bookId, chapterIndex),
      book: bookEpoch(finalized.tts, bookId)
    };
    const finalizedStatus = await deps.inspectChapterAudio(bookId, chapterIndex, {
      clean: false,
      tier: finalized.tier,
      ...fixedOptions(finalized)
    });
    if (finalizedStatus.ready) {
      return {
        bookId,
        chapterIndex,
        voiceId: finalized.actualVoiceId || finalized.voice,
        requestedVoiceId: finalized.requestedVoiceId || finalized.voice,
        servedTier: finalized.servedTier || undefined,
        format: finalized.tts.currentOutputFormat(),
        finalPath: finalized.tts.chapterPath(bookId, chapterIndex),
        totalChunks: 0,
        startChunkIndex: 0,
        decodeStartOffsetSeconds: Math.max(0, Number(startOffsetSeconds) || 0),
        logicalStartOffsetSeconds: Math.max(0, Number(startOffsetSeconds) || 0),
        chunkStartSeconds: 0,
        textEpoch: epochs.text,
        firstAudio: { origin: 'final' },
        waitForChunk: async () => {
          throw new Error('Finalized chapter audio disappeared before it could be served');
        },
        prioritize() {}
      };
    }

    const requestedOffset = Math.max(0, Number(startOffsetSeconds) || 0);
    const initialTargetChunk = await playbackTargetChunk(
      finalized.tts, bookId, chapterIndex, requestedOffset, context.chapter
    );
    let selected;
    try {
      selected = await prepareManifest({
        bookId,
        chapterIndex,
        text: context.chapter.text,
        language: context.book.language || 'en',
        requestedTier,
        targetChunk: initialTargetChunk,
        priority: 'immediate',
        selectedTier: finalized
      });
    } catch (error) {
      throw unplayableChapterError(await unplayableFromError(error, bookId, chapterIndex, context));
    }
    // Build the seekable artifact concurrently for subsequent Range requests.
    // The active progressive response never redirects or switches resources.
    if (assemble) {
      deps.ensureChapterAudio(bookId, chapterIndex, {
        clean: false,
        priority: 'background',
        tier: selected.tier,
      ...fixedOptions(selected)
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
    // Recorded before any wait, so a slow first segment can be attributed to
    // a cache hit, in-flight generation or a cold chunk.
    const firstAudio = {
      origin: 'chunks',
      startChunkStatus: selected.manifest.chunks[startChunkIndex]?.status || 'pending',
      readyChunks: selected.manifest.chunks.filter(chunk => chunk.status === 'ready').length,
      totalChunks: selected.manifest.totalChunks,
      seek: startChunkIndex > 0
    };
    const preparedManifest = selected.manifest;
    const planIdentity = chunkPlanIdentity(epochs, preparedManifest);
    // The loop bound and every index the caller asks for come from the
    // prepared plan. A listener paused ahead of the encoder is not waiting,
    // so no cancellation event reaches it; it must check on its next wait.
    const planChanged = manifest => Boolean(manifest) && manifest !== preparedManifest && chunkPlanIdentity({
      text: chapterTextEpoch(tts, bookId, chapterIndex),
      book: bookEpoch(tts, bookId)
    }, manifest) !== planIdentity;
    const waitForChunk = (chunkIndex, signal) => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        tts.off?.('chunk:ready', onReady);
        tts.off?.('chunk:error', onError);
        tts.off?.('chapter:cancelled', onChapterCancelled);
        tts.off?.('book:cancelled', onBookCancelled);
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
        if (!matches(event)) return;
        if (planChanged(tts.getChapterManifest(bookId, chapterIndex))) finish(reject, chunkPlanChangedError(chunkIndex));
        else finish(resolve, event.path || tts.chunkPath(bookId, chapterIndex, chunkIndex));
      };
      const onError = event => {
        if (event?.bookId !== bookId || event?.chapterIndex !== chapterIndex) return;
        const manifest = tts.getChapterManifest(bookId, chapterIndex);
        const chunk = manifest?.chunks?.[chunkIndex];
        // A different failed clip halts new scheduling for this chapter. Keep
        // usable/in-flight audio, but do not wait for an unscheduled clip whose
        // ready event can no longer arrive.
        if (!matches(event) && !(manifest?._generation?.halted && chunk?.status === 'pending')) return;
        const error = new Error(`Narration chunk ${chunkIndex} failed${!matches(event) ? ': chapter generation halted' : ''}`);
        error.cause = event.error;
        finish(reject, error);
      };
      const onChapterCancelled = event => {
        if (event?.bookId === bookId && event?.chapterIndex === chapterIndex) {
          finish(reject, new Error('Chapter generation cancelled'));
        }
      };
      const onBookCancelled = event => {
        if (event?.bookId === bookId) finish(reject, new Error('Chapter generation cancelled'));
      };
      const onAbort = () => finish(reject, Object.assign(new Error('Audio request closed'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
      }));
      const inspect = () => {
        const manifest = tts.getChapterManifest(bookId, chapterIndex);
        const chunk = manifest?.chunks?.[chunkIndex];
        if (planChanged(manifest)) {
          finish(reject, chunkPlanChangedError(chunkIndex));
        } else if (chunk?.status === 'ready') {
          finish(resolve, chunk.path || tts.chunkPath(bookId, chapterIndex, chunkIndex));
        } else if (chunk?.status === 'error') {
          onError({ bookId, chapterIndex, chunkIndex });
        } else if (!manifest || manifest._generation?.cancelled) {
          finish(reject, new Error('Chapter generation cancelled'));
        } else if (manifest._generation?.halted && chunk?.status === 'pending') {
          finish(reject, new Error(`Narration chunk ${chunkIndex} failed: chapter generation halted`));
        }
      };

      tts.on?.('chunk:ready', onReady);
      tts.on?.('chunk:error', onError);
      tts.on?.('chapter:cancelled', onChapterCancelled);
      tts.on?.('book:cancelled', onBookCancelled);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else inspect();
    });

    return {
      bookId,
      chapterIndex,
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
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
      textEpoch: epochs.text,
      firstAudio,
      waitForChunk,
      prioritize(chunkIndex, priority = GENERATION_PRIORITY.IMMEDIATE) {
        if (priority === GENERATION_PRIORITY.LOOKAHEAD) {
          tts.prioritizeChunk(bookId, chapterIndex, chunkIndex, GENERATION_PRIORITY.LOOKAHEAD);
          return;
        }
        tts.prioritizeChunk(bookId, chapterIndex, chunkIndex, 'immediate');
        tts.prioritizeChunk(bookId, chapterIndex, chunkIndex + 1, 'next');
        // The window slides with the stream, so the chapter being played
        // stays generated ahead of the next chapter's look-ahead.
        prioritizePlaybackBuffer(tts, bookId, chapterIndex, chunkIndex);
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
    // Who asked (lib/routes/playback-routes.js timelineOwnerKey). Scopes the
    // client-chosen sessionId.
    ownerKey = null,
    startOffsetSeconds = 0,
    endChapterIndex: requestedEndChapterIndex = null,
    // Seconds of this stream the client already holds (a `Range: bytes=N-`
    // reconnect). The encode starts that far past startOffsetSeconds, but the
    // timeline keeps the original start so stream time still maps to the
    // same chapter positions on the client.
    resumeSeconds = 0,
    // The request is a reconnect that only a resume can serve. A refused
    // resume then throws (410) instead of falling back to the full stream.
    requireResume = false,
    // Aborted when the request that wants this stream goes away.
    signal = null
  }) {
    const prepareToken = { startedAt: Date.now() };
    const key = timelineKey(ownerKey, sessionId);
    if (key) timelinePrepares.set(key, prepareToken);
    const hasNarration = chapter => isPlayableChapter(chapter) && /[\p{L}\p{N}]/u.test(String(chapter?.text || ''));
    pruneTimelines();
    const context = await deps.getChapterContext(bookId, chapterIndex);
    // The chapter list this stream, its end index and its timeline describe.
    // Every later chapter step re-reads the book and must still match it.
    const structureKey = chapterStructureKey(context.chapters);
    const startUnplayable = await structurallyUnplayable(bookId, chapterIndex, context);
    if (startUnplayable && startUnplayable.nextPlayableChapterIndex !== null) throw unplayableChapterError(startUnplayable);
    const selectedTier = await tierContext(bookId, chapterIndex, requestedTier);
    // Durations and resume proofs hold only for the same narration.
    const narrationKey = JSON.stringify([
      selectedTier.actualVoiceId || selectedTier.voice || '',
      selectedTier.servedTier || selectedTier.tier || '',
      selectedTier.variantKey || selectedTier.tts?.variantKeyProvider?.() || ''
    ]);
    const textEpochOf = index => chapterTextEpoch(selectedTier.tts, bookId, index);
    const startTextEpoch = textEpochOf(chapterIndex);
    const lastChapterIndex = context.chapters.length - 1;
    const endChapterIndex = Number.isInteger(requestedEndChapterIndex)
      ? Math.max(chapterIndex, Math.min(requestedEndChapterIndex, lastChapterIndex))
      : lastChapterIndex;
    // A resume is only honoured when this session's first connection proves
    // where it lands: same book, start chapter, chapter structure, narration
    // and start-chapter text, and either the start chapter was still being
    // decoded (so every byte the client holds is in it) or its measured length
    // leaves room. Anything else would splice different audio at the wrong
    // time. It gets the full stream, or with requireResume a 410 so the client
    // reloads at its own position.
    const refuseResume = () => {
      if (!requireResume) return;
      if (key && timelinePrepares.get(key) === prepareToken) timelinePrepares.delete(key);
      throw Object.assign(new Error('This stream cannot resume here; reload at the current position'), {
        statusCode: 410,
        code: 'CONTINUOUS_RESUME_UNAVAILABLE'
      });
    };
    const previousTimeline = key ? continuousTimelines.get(key) : null;
    const sameStream = Boolean(previousTimeline) &&
      previousTimeline.bookId === bookId &&
      previousTimeline.startChapterIndex === chapterIndex &&
      previousTimeline.chapterStructureKey === structureKey &&
      previousTimeline.narrationKey === narrationKey;
    let resume = Math.max(0, Number(resumeSeconds) || 0);
    let resumeBase = Math.max(0, Number(startOffsetSeconds) || 0);
    if (resume > 0) {
      const sameStart = sameStream && previousTimeline.textEpochs.get(chapterIndex) === startTextEpoch;
      const measured = sameStart ? previousTimeline.durations.get(chapterIndex) : undefined;
      if (!sameStart) {
        resume = 0;
      } else {
        // The first connection's logical start, which may have been clamped.
        resumeBase = Math.max(0, Number(previousTimeline.startOffsetSeconds) || 0);
        if (Number.isFinite(measured) && resumeBase + resume >= measured - 1) resume = 0;
      }
      if (resume === 0) refuseResume();
    }
    const prepareFirst = offset => (hasNarration(context.chapter) ? prepareAudioStreamForTier({
      bookId,
      chapterIndex,
      selectedTier,
      startOffsetSeconds: offset,
      lookAhead: false,
      assemble: false
    }) : Promise.resolve(null));
    let firstStream = await prepareFirst(resume > 0 ? resumeBase + resume : startOffsetSeconds);
    // The seek plan clamps a target past its duration estimate. A clamped
    // resume would decode from the wrong place, so serve the full stream.
    if (resume > 0 && firstStream &&
      Number(firstStream.logicalStartOffsetSeconds) < resumeBase + resume - 0.5) {
      resume = 0;
      refuseResume();
      firstStream = await prepareFirst(startOffsetSeconds);
    }
    const preparedLogicalOffset = Math.max(
      0,
      Number(firstStream?.logicalStartOffsetSeconds) || 0
    );
    // A resumed encode is prepared at base + resume; the stream's logical
    // start stays where the first connection put it.
    const logicalStartOffsetSeconds = resume > 0 ? resumeBase : preparedLogicalOffset;
    const timeline = key ? {
      sessionId,
      ownerKey,
      bookId,
      chapterStructureKey: structureKey,
      narrationKey,
      startChapterIndex: chapterIndex,
      endChapterIndex,
      startOffsetSeconds: logicalStartOffsetSeconds,
      durations: new Map(),
      // index -> text epoch the chapter was narrated under, for the start
      // chapter and every measured one.
      textEpochs: new Map([[chapterIndex, firstStream?.textEpoch ?? startTextEpoch]]),
      pendingDurations: new Map(),
      complete: false,
      updatedAt: Date.now()
    } : null;
    // Measured chapter lengths outlive the connection that measured them. A
    // reconnect replaces this session's timeline; without them a later
    // reconnect would read "start chapter not measured yet" and accept a
    // resume that lands past its end. A length is carried only while it still
    // describes the same audio.
    if (timeline && sameStream) {
      for (const [index, seconds] of previousTimeline.durations) {
        const epoch = previousTimeline.textEpochs.get(index);
        if (epoch !== textEpochOf(index)) continue;
        timeline.durations.set(index, seconds);
        timeline.textEpochs.set(index, epoch);
      }
    }
    if (timeline && firstStream?.chunkStartSeconds > 0) {
      timeline.pendingDurations.set(chapterIndex, firstStream.chunkStartSeconds);
    }
    // index -> text epoch of the source this stream narrates it from.
    const sourceTextEpochs = new Map([[chapterIndex, firstStream?.textEpoch ?? startTextEpoch]]);
    const recordDuration = (index, seconds) => {
      timeline.durations.set(index, seconds);
      timeline.textEpochs.set(index, sourceTextEpochs.get(index) ?? textEpochOf(index));
      timeline.pendingDurations.delete(index);
    };
    // A chapter without narration contributes no audio. Report it as zero
    // seconds so the client maps stream time straight past it. Structural
    // sections are known now; TTS-unspeakable text is found when reached.
    const markSilentChapter = index => {
      if (!timeline) return;
      recordDuration(index, 0);
      timeline.updatedAt = Date.now();
    };
    const skipUnplayableChapter = index => {
      markSilentChapter(index);
      if (timeline && index === timeline.endChapterIndex) timeline.complete = true;
    };
    const chapters = Array.isArray(context.chapters) ? context.chapters : [];
    for (let index = chapterIndex + 1; index <= endChapterIndex; index++) {
      if (index < chapters.length && !hasNarration(chapters[index])) markSilentChapter(index);
    }
    // Each step re-reads the book. A rebuild or metadata refresh can renumber
    // chapters under a stream that runs for hours; the end index, the silent
    // chapters above and the timeline would then name the wrong chapters.
    const prepareFollowingChapter = async index => {
      const next = await deps.getChapterContext(bookId, index).catch(error => {
        if (error?.statusCode === 404) throw chapterStructureChangedError();
        throw error;
      });
      if (chapterStructureKey(next.chapters) !== structureKey) throw chapterStructureChangedError();
      if (!hasNarration(next.chapter)) return null;
      return prepareAudioStreamForTier({
        bookId,
        chapterIndex: index,
        selectedTier,
        lookAhead: false,
        assemble: false,
        context: next
      }).catch(error => {
        // Text that is structurally present can still have nothing to speak.
        if (isUnspeakableChapterError(error)) return null;
        throw error;
      });
    };
    // An abandoned prepare, or one a newer prepare for the same session has
    // superseded, must not replace the timeline the live stream reports.
    if (timeline && !signal?.aborted && timelinePrepares.get(key) === prepareToken) {
      continuousTimelines.set(key, timeline);
      timelinePrepares.delete(key);
    }
    return {
      bookId,
      chapterIndex,
      endChapterIndex,
      voiceId: selectedTier.actualVoiceId || selectedTier.voice,
      requestedVoiceId: selectedTier.requestedVoiceId || selectedTier.voice,
      servedTier: selectedTier.servedTier || undefined,
      format: 'mp3',
      startOffsetSeconds: timeline?.startOffsetSeconds || logicalStartOffsetSeconds,
      decodeStartOffsetSeconds: Math.max(
        0,
        Number(firstStream?.decodeStartOffsetSeconds) || 0
      ),
      // The decode start above already includes resumeSeconds (the seek plan
      // picked the chunk for start + resume), so the transport must not skip
      // the resumed audio a second time.
      resumeAppliedToDecodeStart: true,
      resumeAccepted: resume > 0,
      firstAudioDiagnostics: {
        ...firstStream?.firstAudio,
        voiceId: selectedTier.actualVoiceId || selectedTier.voice,
        tier: selectedTier.servedTier || selectedTier.tier
      },
      outputPacing: {
        burstAudioSeconds: 30,
        // Leave headroom above the player's maximum 3× playback speed.
        realtimeMultiplier: 4
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
          recordDuration(descriptor.chapterIndex, accumulated);
          if (descriptor.chapterIndex === timeline.endChapterIndex) timeline.complete = true;
        }
        timeline.updatedAt = Date.now();
      },
      async *iterateInputs(signal, transport = null) {
        let currentPromise = Promise.resolve(firstStream);
        // Keep the chapter being played out of the cache sweep. The request
        // path names only the start chapter. Abort releases the hold too, in
        // case the consumer abandons the iterator without resuming it.
        const holdChapter = index => deps.holdChapterAudio?.(bookId, index) || (() => {});
        let releaseHeld = holdChapter(chapterIndex);
        const releaseOnAbort = () => releaseHeld();
        signal?.addEventListener('abort', releaseOnAbort, { once: true });
        try {
          for (let index = chapterIndex; index <= endChapterIndex; index++) {
            if (signal?.aborted) throw Object.assign(new Error('Audio request closed'), { name: 'AbortError', code: 'ABORT_ERR' });
            const current = await currentPromise;
            if (current) sourceTextEpochs.set(index, current.textEpoch);
            if (current === null) {
              skipUnplayableChapter(index);
            } else if (current.totalChunks === 0) {
              yield {
                path: current.finalPath,
                chapterIndex: index,
                lastInChapter: true,
                seekable: true
              };
            } else {
              const firstChunkIndex = index === chapterIndex
                ? Math.max(0, Number(current.startChunkIndex) || 0)
                : 0;
              for (let chunkIndex = firstChunkIndex; chunkIndex < current.totalChunks; chunkIndex++) {
                const ahead = Number(transport?.leadSeconds?.()) >= FOREGROUND_LEAD_SECONDS;
                current.prioritize(
                  chunkIndex,
                  ahead ? GENERATION_PRIORITY.LOOKAHEAD : GENERATION_PRIORITY.IMMEDIATE
                );
                const chunkPath = current.waitForChunk(chunkIndex, signal);
                let promotion = null;
                if (ahead && typeof transport.waitForLeadBelow === 'function') {
                  promotion = new AbortController();
                  const stop = () => promotion.abort();
                  signal?.addEventListener('abort', stop, { once: true });
                  transport.waitForLeadBelow(FOREGROUND_LEAD_SECONDS, promotion.signal)
                    .then(() => current.prioritize(chunkIndex), () => {})
                    .finally(() => signal?.removeEventListener('abort', stop));
                }
                let path;
                try {
                  path = await chunkPath;
                } finally {
                  promotion?.abort();
                }
                yield {
                  path,
                  chapterIndex: index,
                  lastInChapter: chunkIndex === current.totalChunks - 1
                };
              }
            }

            if (index >= endChapterIndex) break;
            if (signal?.aborted) throw Object.assign(new Error('Audio request closed'), { name: 'AbortError', code: 'ABORT_ERR' });
            // Hold the next chapter before its readiness check, then let go of this one.
            const releaseFinished = releaseHeld;
            releaseHeld = holdChapter(index + 1);
            releaseFinished();
            currentPromise = prepareFollowingChapter(index + 1);
          }
        } finally {
          signal?.removeEventListener('abort', releaseOnAbort);
          releaseHeld();
        }
      }
    };
  }

  function continuousTimeline(sessionId, ownerKey = null) {
    pruneTimelines();
    const timeline = continuousTimelines.get(timelineKey(ownerKey, sessionId));
    if (!timeline) return null;
    const durations = Array.from(
      { length: timeline.endChapterIndex - timeline.startChapterIndex + 1 },
      (_value, index) => timeline.durations.get(timeline.startChapterIndex + index) ?? null
    );
    return {
      sessionId,
      bookId: timeline.bookId,
      chapterStructureKey: timeline.chapterStructureKey,
      startChapterIndex: timeline.startChapterIndex,
      startOffsetSeconds: timeline.startOffsetSeconds,
      durations,
      complete: timeline.complete,
      updatedAt: timeline.updatedAt
    };
  }

  // A rebuild renumbers the book's chapters. Lengths measured and resume
  // proofs taken under the old numbering would map stream time onto the
  // wrong chapters, so they go with it.
  function evictBookTimelines(bookId) {
    let evicted = 0;
    for (const [key, timeline] of continuousTimelines) {
      if (timeline.bookId !== bookId) continue;
      continuousTimelines.delete(key);
      evicted++;
    }
    return evicted;
  }

  async function prepareChapterAudio({
    bookId,
    chapterIndex,
    requestedTier = null,
    clean = false,
    priority = 'immediate'
  }) {
    const context = await deps.getChapterContext(bookId, chapterIndex);
    const unplayable = await structurallyUnplayable(bookId, chapterIndex, context);
    if (unplayable) throw unplayableChapterError(unplayable);
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    let audioPath;
    try {
      audioPath = await deps.ensureChapterAudio(bookId, chapterIndex, {
        clean,
        priority,
        tier: selected.tier,
        ...fixedOptions(selected)
      });
    } catch (error) {
      throw unplayableChapterError(await unplayableFromError(error, bookId, chapterIndex, context));
    }
    return { ...selected, path: audioPath };
  }

  async function chapterAudioStatus({
    bookId, chapterIndex, requestedTier = null, clean = false, startOffsetSeconds = null, playbackRate = null
  }) {
    const unplayable = await structurallyUnplayable(bookId, chapterIndex);
    if (unplayable) return unplayable;
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    const status = await deps.inspectChapterAudio(bookId, chapterIndex, { clean, tier: selected.tier, ...fixedOptions(selected) });
    return withPlaybackRunway(
      await decorateAudioStatus(status, selected, bookId, chapterIndex),
      selected, bookId, chapterIndex, startOffsetSeconds, playbackRate
    );
  }

  async function decorateAudioStatus(status, selected, bookId, chapterIndex) {
    const result = {
      ...status,
      tier: selected.tier,
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
      servedTier: selected.servedTier || undefined
    };
    if (result.url) result.url += tierQuery(selected);
    if (selected.premiumActive ?? deps.isPremiumVoiceActive()) {
      result.premiumReady = selected.premiumReady ?? await deps.premiumChapterReady(bookId, chapterIndex);
      result.instantVoice = selected.instantVoice ?? deps.activeInstantVoice();
    }
    return result;
  }

  async function startChapterAudio({
    bookId,
    chapterIndex,
    requestedTier = null,
    clean = false,
    priority = 'background',
    completeChapter = false,
    startOffsetSeconds = null,
    playbackRate = null,
    origin = GENERATION_ORIGIN.PLAYBACK_CURRENT
  }) {
    const context = await deps.getChapterContext(bookId, chapterIndex);
    const unplayable = await structurallyUnplayable(bookId, chapterIndex, context);
    if (unplayable) return unplayable;
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    // Text can be present and still have nothing to speak. Check before any
    // background work starts, so no caller waits on a chapter that never
    // becomes ready. An existing manifest already proves speakable text.
    if (
      !selected.tts.getChapterManifest?.(bookId, chapterIndex)
      && typeof selected.tts.hasSpeakableText === 'function'
      && !await selected.tts.hasSpeakableText(
        bookId, chapterIndex, context.chapter.text, context.book.language || 'en'
      )
    ) {
      return unplayableChapterStatus(bookId, chapterIndex, context.chapters);
    }
    // Resolve and promote the requested clips before starting complete-chapter
    // work. Giving the whole chapter immediate priority starves seeks near its
    // end and other listeners behind clips they do not need yet.
    const playbackRunway = startOffsetSeconds !== null;
    if (playbackRunway) {
      const existing = await deps.inspectChapterAudio(bookId, chapterIndex, { clean, tier: selected.tier, ...fixedOptions(selected) });
      if (!existing.ready) {
        const { book, chapter } = context;
        try {
          const targetChunk = await playbackTargetChunk(selected.tts, bookId, chapterIndex, startOffsetSeconds, chapter);
          await prepareManifest({
            bookId, chapterIndex, text: chapter.text, language: book.language || 'en',
            requestedTier, targetChunk, selectedTier: selected, origin
          });
        } catch (error) {
          return unplayableFromError(error, bookId, chapterIndex, context);
        }
      }
    }
    const generationPriority = priority === 'download'
      ? 'download'
      : priority === 'immediate'
        ? 'immediate'
        : priority === 'lookahead'
          ? 'lookahead'
          : 'background';
    deps.ensureChapterAudio(bookId, chapterIndex, {
      clean,
      priority: playbackRunway ? 'background' : generationPriority,
      completeChapter,
      origin,
      // Keep the all-chapter background claim separate from the bounded
      // foreground claim, including when generation is waiting for capacity.
      ...(playbackRunway ? { requestId: 'playback-assembly' } : {}),
      tier: selected.tier,
      ...fixedOptions(selected)
    }).catch(error => {
      if (!isUnspeakableChapterError(error)) deps.onBackgroundError?.(error, { bookId, chapterIndex });
    });
    const status = await deps.inspectChapterAudio(bookId, chapterIndex, { clean, tier: selected.tier, ...fixedOptions(selected) });
    return withPlaybackRunway(
      await decorateAudioStatus(status, selected, bookId, chapterIndex),
      selected, bookId, chapterIndex, startOffsetSeconds, playbackRate
    );
  }

  async function chunkStatus({ bookId, chapterIndex, requestedTier = null }) {
    const selected = await tierContext(bookId, chapterIndex, requestedTier);
    let manifest = selected.tts.getChapterManifest(bookId, chapterIndex);
    if (!manifest) {
      const context = await deps.getChapterContext(bookId, chapterIndex);
      const unplayable = await structurallyUnplayable(bookId, chapterIndex, context);
      if (unplayable) return unplayable;
      try {
        manifest = await selected.tts.reconstructChapterManifest(
          bookId,
          chapterIndex,
          context.chapter.text,
          context.book.language || 'en'
        );
      } catch (error) {
        return unplayableFromError(error, bookId, chapterIndex, context);
      }
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
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
      servedTier: selected.servedTier || undefined
    };
    if (selected.premiumActive ?? deps.isPremiumVoiceActive()) {
      result.premiumReady = selected.premiumReady ?? await deps.premiumChapterReady(bookId, chapterIndex);
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
      voiceId: selected.actualVoiceId || selected.voice,
      requestedVoiceId: selected.requestedVoiceId || selected.voice,
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
    evictBookTimelines,
    prepareChapterAudio,
    chapterAudioStatus,
    startChapterAudio,
    chunkStatus,
    prioritizeChunk,
    chunkAccess
  };
}

module.exports = { createPlaybackOrchestrator };
