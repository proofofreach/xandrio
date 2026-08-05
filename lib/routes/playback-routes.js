/**
 * Playback + chunked-audio HTTP routes.
 *
 * These handlers are thin: every one of them delegates to playbackOrchestrator
 * and reports errors. They were lifted verbatim out of server.js — collaborators
 * arrive through the factory rather than module scope, matching the seam the
 * other lib/routes modules use.
 *
 * Registration ORDER is load-bearing: the literal-suffix chunk routes
 * (.../manifest, .../status, .../prepare, .../retry, …) must be registered
 * before the catch-all .../:chunkIndex route, or Express would match e.g.
 * "manifest" as a chunk index. Keep this order when editing.
 */

const { rateLimit } = require('express-rate-limit');
const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');

async function replayOfflinePreparations({
  offlinePreparationCoordinator
}) {
  if (!offlinePreparationCoordinator?.restore) {
    return { resumedBooks: 0, resumedChapters: 0, failedBooks: [] };
  }
  const report = await offlinePreparationCoordinator.restore();
  return { ...report, resumedChapters: 0 };
}

function registerPlaybackRoutes(app, {
  playbackOrchestrator,
  ttsForTier,
  generationJournal,
  offlinePreparationCoordinator,
  chapterAudioStreamer,
  hlsAudioStreamer,
  serveAudioFile,
  sendServerError,
  fs,
  getBookChapters,
  getOfflineChapterAudio,
  offlineReadinessNotifications,
  onCurrentChapterPrepared = async () => {},
  offlinePreparationOwner = () => null,
  prioritizeForegroundBook = () => ({ queuedJobs: 0, queuedPreparation: false }),
  rateLimitWindowMs = 60_000,
  rateLimitMax = 60
}) {
  const playbackMediaRateLimit = rateLimit({
    windowMs: Math.max(1_000, Number(rateLimitWindowMs) || 60_000),
    // Native HLS polls its EVENT playlist and fetches finite segments in
    // parallel. A low TTS-style request ceiling interrupts healthy playback,
    // so transport reads get a high flood ceiling while *new session*
    // creation remains independently limited to 12/minute per account.
    limit: Math.max(600, (Number(rateLimitMax) || 60) * 10),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many playback media requests. Try again shortly.' }
  });
  const playbackSessionId = value => (
    typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value)
      ? value
      : null
  );
  const startOffsetSeconds = value => Math.min(
    24 * 60 * 60,
    Math.max(0, Number(value) || 0)
  );
  const playbackOwnerId = value => (
    typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value)
      ? value
      : null
  );
  const endChapterIndex = value => {
    if (value === undefined || value === null || value === '') return null;
    return parseNonNegativeInteger(value);
  };
  const sendPlaybackCapacityError = (res, err) => {
    if ((err.statusCode === 429 || err.statusCode === 503) && !res.headersSent) {
      res.set('Retry-After', String(err.retryAfter || 1));
      res.status(err.statusCode).json({
        error: err.statusCode === 429
          ? 'Too many new playback sessions'
          : 'Playback capacity is temporarily busy'
      });
      return true;
    }
    return false;
  };
  const loadOfflinePreparationTarget = async bookId => {
    if (!isSafeBookId(bookId)) {
      const error = new Error('Invalid book identifier');
      error.statusCode = 400;
      throw error;
    }
    if (typeof getBookChapters !== 'function') {
      const error = new Error('Offline preparation is unavailable');
      error.statusCode = 503;
      throw error;
    }
    if (!offlinePreparationCoordinator) {
      const error = new Error('Offline preparation is unavailable');
      error.statusCode = 503;
      throw error;
    }
    return getBookChapters(bookId);
  };
  const sendOfflinePreparationError = (res, error) => {
    if (
      error?.statusCode === 400 ||
      error?.statusCode === 404 ||
      error?.statusCode === 429 ||
      error?.statusCode === 503
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    sendServerError(res, error, 'Failed to prepare offline audio');
  };

  app.post('/api/playback/foreground/:bookId', (req, res) => {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const result = prioritizeForegroundBook(bookId) || {};
    res.json({
      bookId,
      queuedJobs: Math.max(0, Number(result.queuedJobs) || 0),
      queuedPreparation: Boolean(result.queuedPreparation)
    });
  });

  app.get('/api/offline/preparation/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      await loadOfflinePreparationTarget(bookId);
      res.json(await offlinePreparationCoordinator.status(bookId));
    } catch (error) {
      sendOfflinePreparationError(res, error);
    }
  });

  app.get('/api/offline/notifications', (_req, res) => {
    res.json({
      enabled: Boolean(offlineReadinessNotifications?.enabled),
      publicKey: offlineReadinessNotifications?.publicKey || ''
    });
  });

  app.post('/api/offline/notifications', async (req, res) => {
    try {
      if (!offlineReadinessNotifications?.enabled) {
        return res.status(503).json({ error: 'Readiness notifications are unavailable' });
      }
      await offlineReadinessNotifications.subscribe(
        offlinePreparationOwner(req),
        req.body?.subscription
      );
      res.status(201).json({ subscribed: true });
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: error.message });
      sendServerError(res, error, 'Failed to save readiness notification');
    }
  });

  app.delete('/api/offline/notifications', async (req, res) => {
    try {
      if (!offlineReadinessNotifications?.enabled) {
        return res.json({ subscribed: false });
      }
      const removed = await offlineReadinessNotifications.unsubscribe(
        offlinePreparationOwner(req),
        req.body?.endpoint
      );
      res.json({ subscribed: !removed });
    } catch (error) {
      sendServerError(res, error, 'Failed to remove readiness notification');
    }
  });

  app.post('/api/offline/preparation/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      await loadOfflinePreparationTarget(bookId);
      res.status(202).json(await offlinePreparationCoordinator.request(bookId, {
        ownerId: offlinePreparationOwner(req)
      }));
    } catch (error) {
      sendOfflinePreparationError(res, error);
    }
  });

  app.delete('/api/offline/preparation/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      await loadOfflinePreparationTarget(bookId);
      res.json(await offlinePreparationCoordinator.cancel(bookId, {
        ownerId: offlinePreparationOwner(req)
      }));
    } catch (error) {
      sendOfflinePreparationError(res, error);
    }
  });

  app.get('/api/offline/audio/:bookId/:chapterIndex', playbackMediaRateLimit, async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      if (typeof getOfflineChapterAudio !== 'function') {
        return res.status(503).json({ error: 'Offline audio packages are unavailable' });
      }
      const prepared = await getOfflineChapterAudio({
        bookId,
        chapterIndex,
        packageVariantKey: typeof req.query?.variant === 'string'
          ? req.query.variant
          : ''
      });
      if (!prepared?.ready || !prepared.path) {
        return res.status(409).json({ error: 'Offline audio is still preparing' });
      }
      return await serveAudioFile(req, res, prepared.path);
    } catch (error) {
      if (error instanceof TypeError) {
        return res.status(400).json({ error: error.message });
      }
      if (error?.statusCode === 404) {
        return res.status(404).json({ error: error.message });
      }
      sendServerError(res, error, 'Failed to serve offline audio');
    }
  });

  app.get(
    '/api/audio-hls/:bookId/:chapterIndex/index.m3u8',
    playbackMediaRateLimit,
    async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      const sessionId = playbackSessionId(req.query.session);
      const ownerId = playbackOwnerId(req.query.owner);
      const requestedEndChapter = endChapterIndex(req.query.endChapter);
      if (
        !isSafeBookId(bookId)
        || chapterIndex === null
        || !sessionId
        || !ownerId
        || (req.query.endChapter !== undefined && requestedEndChapter === null)
      ) {
        return res.status(400).json({ error: 'Invalid HLS playback identifier' });
      }
      const offset = startOffsetSeconds(req.query.offsetSeconds);
      const tier = req.query.tier === 'instant' || req.query.tier === 'premium'
        ? req.query.tier
        : '';
      return await hlsAudioStreamer.servePlaylist(req, res, {
        key: `${bookId}:${chapterIndex}:${tier}:${offset}:${requestedEndChapter ?? 'book'}:${sessionId}`,
        ownerKey: `${req.user?.id || req.ip || 'legacy'}:${ownerId}`,
        rateKey: String(req.user?.id || req.ip || 'legacy'),
        createSource: () => playbackOrchestrator.prepareContinuousAudioStream({
          bookId,
          chapterIndex,
          requestedTier: tier || null,
          sessionId,
          startOffsetSeconds: offset,
          endChapterIndex: requestedEndChapter
        })
      });
    } catch (err) {
      if (sendPlaybackCapacityError(res, err)) return;
      console.error('HLS book audio error:', err);
      sendServerError(res, err, 'Failed to prepare HLS book audio');
    }
    }
  );

  app.get(
    '/api/audio-hls-segment/:sessionId/:fileName',
    playbackMediaRateLimit,
    async (req, res) => {
    try {
      return await hlsAudioStreamer.serveSegment(
        req,
        res,
        req.params.sessionId,
        req.params.fileName
      );
    } catch (err) {
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('HLS segment error:', err);
      sendServerError(res, err, 'Failed to serve HLS audio segment');
    }
    }
  );

  app.get('/api/audio-timeline/:sessionId', playbackMediaRateLimit, (req, res) => {
    const sessionId = playbackSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid playback session identifier' });
    const timeline = playbackOrchestrator.continuousTimeline(sessionId);
    if (!timeline) return res.status(404).json({ error: 'Playback timeline not ready' });
    res.set('Cache-Control', 'no-store');
    return res.json(timeline);
  });

  // API: One native-media response spanning the requested chapter through the
  // end of the book. The orchestrator pins the selected tier once and warms
  // exactly one chapter ahead while the transport keeps one encoder alive.
  app.get('/api/audio-continuous/:bookId/:chapterIndex', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      const requestedEndChapter = endChapterIndex(req.query.endChapter);
      if (
        !isSafeBookId(bookId)
        || chapterIndex === null
        || (req.query.endChapter !== undefined && requestedEndChapter === null)
      ) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const source = await playbackOrchestrator.prepareContinuousAudioStream({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier,
        sessionId: playbackSessionId(req.query.session),
        startOffsetSeconds: startOffsetSeconds(req.query.offsetSeconds),
        endChapterIndex: requestedEndChapter
      });
      return await chapterAudioStreamer.streamContinuous(req, res, source);
    } catch (err) {
      if (chapterAudioStreamer.isClientDisconnect?.(err)) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      if (sendPlaybackCapacityError(res, err)) return;
      console.error('Continuous book audio error:', err);
      sendServerError(res, err, 'Failed to stream continuous book audio');
    }
  });

  // API: One stable native-media response for first play. While generation is
  // in flight it appends completed chunks in order; once chapter assembly is
  // available, the same URL serves the finalized file with normal Range
  // behavior.
  app.get('/api/audio-stream/:bookId/:chapterIndex', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const source = await playbackOrchestrator.prepareAudioStream({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier
      });
      return await chapterAudioStreamer.stream(req, res, source);
    } catch (err) {
      if (chapterAudioStreamer.isClientDisconnect?.(err)) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('Progressive chapter audio error:', err);
      sendServerError(res, err, 'Failed to stream chapter audio');
    }
  });

  // API: Test chunked audio generation (legacy endpoint, updated for new chunked system)
  app.get('/api/audio-chunked/:bookId/:chapterIndex', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const startTime = Date.now();
      const response = await playbackOrchestrator.prepareFirstChunk({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier
      });
      res.json({ ...response, generationTime: Date.now() - startTime });

    } catch (err) {
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('Chunked audio generation error:', err);
      sendServerError(res, err, "Failed to load audio");
    }
  });

  // API: Serve audio chunks
  app.get('/api/serve-chunk/:filename', (req, res) => {
    const redirect = playbackOrchestrator.legacyChunkRedirect(req.params.filename);
    if (!redirect) {
      return res.status(403).json({ error: 'Invalid chunk filename' });
    }
    res.redirect(307, redirect);
  });

  // API: Get audio for chapter (backward-compatible, now uses chunked generation as backend)
  app.get('/api/audio/:bookId/:chapterIndex', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const { path: preparedPath, servedTier } = await playbackOrchestrator.prepareChapterAudio({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier,
        priority: 'immediate'
      });
      if (servedTier) res.set('X-Served-Tier', servedTier);
      return await serveAudioFile(req, res, preparedPath);
    } catch (err) {
      if (err.message === 'Book not found' || err.message === 'Chapter not found') {
        return res.status(404).json({ error: err.message });
      }
      console.error('Audio generation error:', err);
      sendServerError(res, err, "Failed to load audio");
    }
  });

  // API: Get clean iOS chapter audio.
  app.get('/api/audio-ios/:bookId/:chapterIndex', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }

      const { path: preparedPath, servedTier } = await playbackOrchestrator.prepareChapterAudio({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier,
        clean: true,
        priority: 'immediate'
      });
      if (servedTier) res.set('X-Served-Tier', servedTier);
      return await serveAudioFile(req, res, preparedPath);
    } catch (err) {
      console.error('iOS audio generation error:', err);
      sendServerError(res, err, "Failed to load audio");
    }
  });

  // API: Get chapter chunk manifest (triggers generation if needed)
  app.get('/api/chunks/:bookId/:chapterIndex/manifest', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const response = await playbackOrchestrator.preparePlayback({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier,
        targetChunk: parseNonNegativeInteger(String(req.query.targetChunk ?? 0)) ?? 0
      });
      res.json(response);
    } catch (err) {
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('Chunk manifest error:', err);
      sendServerError(res, err, "Failed to load chunk manifest");
    }
  });

  // API: Get status for reliable single-file chapter audio.
  app.get('/api/chunks/:bookId/:chapterIndex/chapter-audio-status', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      res.json(await playbackOrchestrator.chapterAudioStatus({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier,
        clean: req.query.clean === '1'
      }));
    } catch (err) {
      console.error('Chapter audio status error:', err);
      sendServerError(res, err, "Failed to get chapter audio status");
    }
  });

  // API: Prepare reliable single-file chapter audio in the background.
  app.post('/api/chunks/:bookId/:chapterIndex/prepare-chapter-audio', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }

      const clean = req.query.clean === '1' || req.body?.clean === true;
      const priority = req.body?.purpose === 'offline-download' ? 'download' : 'background';
      const status = await playbackOrchestrator.startChapterAudio({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier || req.body?.tier,
        clean,
        priority
      });
      res.status(202).json(status);
    } catch (err) {
      console.error('Chapter audio prepare error:', err);
      sendServerError(res, err, "Failed to prepare chapter audio");
    }
  });

  // API: Prepare the current chapter after a voice change without forcing a full chapter regen first.
  app.post('/api/chunks/:bookId/:chapterIndex/prepare', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      const requestedTargetChunk = Math.max(0, parseInt(req.body?.targetChunk ?? 0) || 0);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const prepared = await playbackOrchestrator.prepareCurrentChapter({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier || req.body?.tier,
        targetChunk: requestedTargetChunk
      });
      await onCurrentChapterPrepared({ req, bookId, chapterIndex, prepared });
      res.json(prepared);
    } catch (err) {
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('Chunk prepare error:', err);
      sendServerError(res, err, "Failed to prepare chunks");
    }
  });

  // Explicit user retry: automatic startup recovery respects quarantine, while
  // this action clears it for the currently requested playback tier and starts
  // a fresh generation attempt.
  app.post('/api/chunks/:bookId/:chapterIndex/retry', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }
      const resolution = await playbackOrchestrator.resolveTier(bookId, chapterIndex, req.query.tier || req.body?.tier);
      const tts = ttsForTier(resolution.tier);
      const variantKey = String(tts.variantKeyProvider() || 'default');
      await generationJournal.clearChapterQuarantine(bookId, chapterIndex, variantKey);
      const prepared = await playbackOrchestrator.prepareCurrentChapter({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier || req.body?.tier,
        targetChunk: Math.max(0, parseInt(req.body?.targetChunk ?? 0) || 0)
      });
      res.json({ retried: true, ...prepared });
    } catch (err) {
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('Chunk retry error:', err);
      sendServerError(res, err, 'Failed to retry chapter narration');
    }
  });

  // API: Get chunk generation status for a chapter
  app.get('/api/chunks/:bookId/:chapterIndex/status', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null) {
        return res.status(400).json({ error: 'Invalid book or chapter identifier' });
      }

      const status = await playbackOrchestrator.chunkStatus({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier
      });
      const resolution = await playbackOrchestrator.resolveTier(bookId, chapterIndex, req.query.tier);
      const variantKey = String(ttsForTier(resolution.tier).variantKeyProvider() || 'default');
      const quarantined = (await generationJournal.listQuarantinedChapters()).find(entry =>
        entry.bookId === bookId && entry.chapterIndex === chapterIndex && entry.variantKey === variantKey
      );
      res.json({
        ...status,
        recovery: quarantined ? {
          quarantined: true,
          attempts: quarantined.attempts || 0,
          message: 'Generation paused after repeated failures. Use retry after correcting the voice or engine.'
        } : { quarantined: false }
      });
    } catch (err) {
      if (err.statusCode === 404) return res.status(404).json({ error: err.message });
      console.error('Chunk status error:', err);
      sendServerError(res, err, "Failed to get chunk status");
    }
  });

  // API: Prioritize a queued chunk, usually after seeking into an uncached voice variant
  app.post('/api/chunks/:bookId/:chapterIndex/:chunkIndex/prioritize', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      const chunkIndex = parseNonNegativeInteger(req.params.chunkIndex);

      if (!isSafeBookId(bookId) || chapterIndex === null || chunkIndex === null) {
        return res.status(400).json({ error: 'Invalid chunk' });
      }

      const result = await playbackOrchestrator.prioritizeChunk({
        bookId,
        chapterIndex,
        chunkIndex,
        requestedTier: req.query.tier
      });
      if (!result) {
        return res.status(404).json({ error: 'Chunk not found' });
      }
      res.json(result);
    } catch (err) {
      console.error('Chunk prioritize error:', err);
      sendServerError(res, err, "Failed to prioritize chunk");
    }
  });

  // API: Serve individual playback audio chunk
  // Numbered chunk delivery is covered by the global custom TTS limiter.
  // codeql[js/missing-rate-limiting]
  app.get('/api/chunks/:bookId/:chapterIndex/:chunkIndex', async (req, res) => {
    try {
      const { bookId } = req.params;
      const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
      const chunkIndex = parseNonNegativeInteger(req.params.chunkIndex);
      if (!isSafeBookId(bookId) || chapterIndex === null || chunkIndex === null) {
        return res.status(400).json({ error: 'Invalid chunk' });
      }

      const access = await playbackOrchestrator.chunkAccess({
        bookId,
        chapterIndex,
        chunkIndex,
        requestedTier: req.query.tier
      });
      const chunkFilePath = access.path;
      if (access.servedTier) res.set('X-Served-Tier', access.servedTier);

      // Check if chunk file exists on disk
      try {
        await fs.access(chunkFilePath);
      } catch {
        // File not on disk — check manifest for status
        if (access.status !== 'missing') {
          if (access.status === 'queued' || access.status === 'generating') {
            return res.status(202).json({ status: 'generating' });
          }
          if (access.status === 'error') {
            return res.status(500).json({ status: 'error', error: 'Chunk generation failed' });
          }
        }
        return res.status(404).json({ error: 'Chunk not found' });
      }

      // Serve the chunk with range request support
      const stat = await fs.stat(chunkFilePath);
      const fileSize = stat.size;

      // Guard against 0-byte files (failed TTS generation)
      if (fileSize === 0) {
        // Delete the corrupt file so it can be regenerated
        try { await fs.unlink(chunkFilePath); } catch {}
        return res.status(202).json({ status: 'generating', error: 'Chunk was empty, queued for regeneration' });
      }

      await serveAudioFile(req, res, chunkFilePath);
    } catch (err) {
      console.error('Chunk serve error:', err);
      sendServerError(res, err, "Failed to load chunk");
    }
  });
}

module.exports = { registerPlaybackRoutes, replayOfflinePreparations };
