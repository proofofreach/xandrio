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

const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');

function registerPlaybackRoutes(app, {
  playbackOrchestrator,
  ttsForTier,
  generationJournal,
  serveAudioFile,
  sendServerError,
  fs
}) {
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
        targetChunk: 0
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
      const status = await playbackOrchestrator.startChapterAudio({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier || req.body?.tier,
        clean
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
      res.json(await playbackOrchestrator.prepareCurrentChapter({
        bookId,
        chapterIndex,
        requestedTier: req.query.tier || req.body?.tier,
        targetChunk: requestedTargetChunk
      }));
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

module.exports = { registerPlaybackRoutes };
