'use strict';

const { rateLimit } = require('express-rate-limit');
const { isSafeBookId: defaultIsSafeBookId } = require('../request-guards');
const { publicNarrationManifest } = require('../book-guide-narration');
const { badRequest } = require('../http-error');

const ERROR_STATUS = Object.freeze({
  BOOK_GUIDE_INVALID_BOOK_ID: 400,
  BOOK_GUIDE_NONFICTION_CONFIRMATION_REQUIRED: 400,
  BOOK_GUIDE_EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED: 400,
  BOOK_GUIDE_EXTERNAL_PROCESSING_ACKNOWLEDGEMENT_REQUIRED: 400,
  BOOK_GUIDE_PROVIDER_URL_INVALID: 400,
  BOOK_GUIDE_MODEL_REQUIRED: 400,
  BOOK_GUIDE_CATEGORY_INVALID: 400,
  BOOK_GUIDE_BOOK_NOT_FOUND: 404,
  BOOK_GUIDE_NOT_FOUND: 404,
  BOOK_GUIDE_ANCHOR_NOT_FOUND: 404,
  BOOK_GUIDE_NARRATION_SECTION_NOT_FOUND: 404,
  BOOK_GUIDE_DISABLED: 409,
  BOOK_GUIDE_UNAVAILABLE: 409,
  BOOK_GUIDE_LANGUAGE_UNSUPPORTED: 409,
  BOOK_GUIDE_NONFICTION_TAG_REQUIRED: 409,
  BOOK_GUIDE_SOURCE_CHANGED: 409,
  BOOK_GUIDE_ANCHOR_STALE: 409,
  BOOK_GUIDE_MODEL_UNAVAILABLE: 409,
  BOOK_GUIDE_MODEL_DIGEST_INVALID: 409,
  BOOK_GUIDE_MODEL_CHANGED: 409,
  BOOK_GUIDE_MODEL_SUBSTITUTED: 409,
  BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING: 409,
  BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID: 409,
  BOOK_GUIDE_PROVIDER_FUNDS_REQUIRED: 409,
  BOOK_GUIDE_PROVIDER_LOGIN_UNAVAILABLE: 409,
  BOOK_GUIDE_CERTIFICATION_MISSING_OR_FAILED: 409,
  BOOK_GUIDE_CERTIFICATION_PROVENANCE_MISMATCH: 409,
  BOOK_GUIDE_NARRATION_UNAVAILABLE: 503
});

function publicError(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('BOOK_GUIDE_')
    ? error.code
    : 'BOOK_GUIDE_OPERATION_FAILED';
  const status = ERROR_STATUS[code] || (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 600
    ? Number(error.statusCode)
    : 500);
  const messages = {
    BOOK_GUIDE_INVALID_BOOK_ID: 'Invalid book identifier',
    BOOK_GUIDE_NONFICTION_CONFIRMATION_REQUIRED: 'Confirm that this book is nonfiction.',
    BOOK_GUIDE_EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED: 'Confirm that the book may be sent to the configured provider for processing.',
    BOOK_GUIDE_EXTERNAL_PROCESSING_ACKNOWLEDGEMENT_REQUIRED: 'Acknowledge external book processing when configuring the provider.',
    BOOK_GUIDE_PROVIDER_URL_INVALID: 'The configured study-guide provider destination is invalid.',
    BOOK_GUIDE_MODEL_REQUIRED: 'Choose a supported study-guide model.',
    BOOK_GUIDE_CATEGORY_INVALID: 'Choose nonfiction or remove the study-guide tag.',
    BOOK_GUIDE_BOOK_NOT_FOUND: 'Book not found',
    BOOK_GUIDE_NOT_FOUND: 'Book guide not found',
    BOOK_GUIDE_ANCHOR_NOT_FOUND: 'Guide anchor not found',
    BOOK_GUIDE_NARRATION_SECTION_NOT_FOUND: 'Study-guide audio section not found.',
    BOOK_GUIDE_DISABLED: 'Book guides are disabled.',
    BOOK_GUIDE_UNAVAILABLE: 'Book guides are not configured or available.',
    BOOK_GUIDE_LANGUAGE_UNSUPPORTED: 'Book guides currently support English nonfiction only.',
    BOOK_GUIDE_NONFICTION_TAG_REQUIRED: 'Tag this title as nonfiction before creating a study guide.',
    BOOK_GUIDE_SOURCE_CHANGED: 'The book changed during guide generation. Try again.',
    BOOK_GUIDE_ANCHOR_STALE: 'This source link no longer resolves exactly.',
    BOOK_GUIDE_MODEL_UNAVAILABLE: 'The configured study-guide model is unavailable.',
    BOOK_GUIDE_MODEL_DIGEST_INVALID: 'The study-guide model identity is invalid.',
    BOOK_GUIDE_MODEL_CHANGED: 'The configured model changed. Review and save the configuration again.',
    BOOK_GUIDE_MODEL_SUBSTITUTED: 'The provider returned a different model than the configured model.',
    BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING: 'Connect the study-guide provider in Settings.',
    BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID: 'The study-guide provider connection was rejected. Reconnect it in Settings.',
    BOOK_GUIDE_PROVIDER_FUNDS_REQUIRED: 'The PPQ.ai account has insufficient credit.',
    BOOK_GUIDE_PROVIDER_LOGIN_UNAVAILABLE: 'This study-guide provider does not support account sign-in.',
    BOOK_GUIDE_PROVIDER_RESPONSE_INVALID: 'The provider returned an invalid study-guide response.',
    BOOK_GUIDE_PROVIDER_UNAVAILABLE: 'The study-guide provider is unavailable. Try again later.',
    BOOK_GUIDE_CERTIFICATION_MISSING_OR_FAILED: 'The configured models do not have a passing local benchmark certificate.',
    BOOK_GUIDE_CERTIFICATION_PROVENANCE_MISMATCH: 'The benchmark certificate does not match the configured models and guide recipe.',
    BOOK_GUIDE_NARRATION_UNAVAILABLE: 'Study-guide narration is temporarily unavailable.'
  };
  return { status, code, message: messages[code] || 'Book guide operation failed.' };
}

function registerBookGuideRoutes(app, {
  service,
  requireAdmin,
  setBookCategory = null,
  prepareNarrationAudio = null,
  narrationStatus = null,
  narrationVariant = null,
  serveAudioFile = null,
  providerStatusRateLimit = null,
  providerLoginRateLimit = null,
  guideGenerateRateLimit = null,
  guideDailyRateLimit = null,
  guideReadRateLimit = null,
  isSafeBookId = defaultIsSafeBookId,
  log = console
} = {}) {
  if (!app || !service || typeof requireAdmin !== 'function') {
    throw new TypeError('Book guide routes require app, service, and requireAdmin');
  }
  const statusRateLimit = providerStatusRateLimit || rateLimit({
    windowMs: 60_000,
    limit: 90,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many provider status requests. Try again shortly.' }
  });
  const loginRateLimit = providerLoginRateLimit || rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many provider sign-in requests. Try again shortly.' }
  });
  // Generation is the most expensive operation in the product (dozens of
  // paid model calls per request); a handful per hour is ample for the
  // intended "generate a guide, occasionally regenerate" usage.
  const generateRateLimit = guideGenerateRateLimit || rateLimit({
    windowMs: 60 * 60_000,
    limit: 3,
    keyGenerator: () => 'global-book-guide-generation',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'The instance study-guide generation budget is exhausted. Try again later.' }
  });
  const dailyGenerateRateLimit = guideDailyRateLimit || rateLimit({
    windowMs: 24 * 60 * 60_000,
    limit: 10,
    keyGenerator: () => 'global-book-guide-generation',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'The instance daily study-guide generation budget is exhausted.' }
  });
  // Reads recompute a normalized book-text snapshot (NFKC + SHA-256 over the
  // whole book) on every request; cap the rate so a request loop cannot
  // saturate the event loop.
  const readRateLimit = guideReadRateLimit || rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many study-guide requests. Try again shortly.' }
  });

  function validBook(req, res) {
    if (isSafeBookId(req.params.bookId)) return true;
    badRequest(res, 'Invalid book identifier', 'BOOK_GUIDE_INVALID_BOOK_ID');
    return false;
  }

  function sendError(res, error, label) {
    const safe = publicError(error);
    if (safe.status >= 500) log.error(`${label} failed: ${safe.code}`);
    return res.status(safe.status).json({ error: safe.message, code: safe.code });
  }

  app.get('/api/book/:bookId/guide/anchors/:anchorId/context', readRateLimit, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      res.json(await service.getAnchorContext(req.params.bookId, req.params.anchorId));
    } catch (error) {
      sendError(res, error, 'Book guide context');
    }
  });

  app.get('/api/book/:bookId/guide/narration/status', async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      if (typeof narrationStatus !== 'function') {
        const unavailable = new Error('Study-guide narration unavailable');
        unavailable.code = 'BOOK_GUIDE_NARRATION_UNAVAILABLE';
        unavailable.statusCode = 503;
        throw unavailable;
      }
      res.set('Cache-Control', 'private, no-store');
      res.json(await narrationStatus(req.params.bookId));
    } catch (error) {
      sendError(res, error, 'Book guide narration status');
    }
  });

  app.get('/api/book/:bookId/guide/narration/:sectionId/audio', readRateLimit, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      if (typeof prepareNarrationAudio !== 'function' || typeof serveAudioFile !== 'function') {
        const unavailable = new Error('Study-guide narration unavailable');
        unavailable.code = 'BOOK_GUIDE_NARRATION_UNAVAILABLE';
        unavailable.statusCode = 503;
        throw unavailable;
      }
      const prepared = await prepareNarrationAudio(req.params.bookId, req.params.sectionId);
      res.set('X-Study-Guide-Section', prepared.sectionId);
      return await serveAudioFile(req, res, prepared.path);
    } catch (error) {
      sendError(res, error, 'Book guide narration');
    }
  });

  app.get('/api/book/:bookId/guide', readRateLimit, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      const result = await service.get(req.params.bookId);
      const canManage = req.user?.role === 'admin';
      const { generation: _privateGeneration, ...publicResult } = result;
      const narration = result.artifact
        ? publicNarrationManifest(req.params.bookId, result.artifact)
        : { available: false, version: null, sections: [] };
      const voiceVariant = typeof narrationVariant === 'function'
        ? String(narrationVariant() || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
        : '';
      if (narration.version && voiceVariant) narration.version = `${narration.version}-${voiceVariant}`;
      res.json({
        ...(canManage ? result : publicResult),
        narration,
        canManage,
        canGenerate: Boolean(result.canGenerate && canManage)
      });
    } catch (error) {
      sendError(res, error, 'Book guide read');
    }
  });

  app.post('/api/book/:bookId/guide', requireAdmin, dailyGenerateRateLimit, generateRateLimit, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      const job = await service.start(req.params.bookId);
      res.status(202).json({ status: job?.status || 'pending', job });
    } catch (error) {
      sendError(res, error, 'Book guide generation');
    }
  });

  app.put('/api/book/:bookId/guide/category', requireAdmin, generateRateLimit, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      if (typeof setBookCategory !== 'function') throw new Error('Book category persistence unavailable');
      res.json(await setBookCategory(req.params.bookId, req.body?.category));
    } catch (error) {
      sendError(res, error, 'Book guide category');
    }
  });

  app.post('/api/book/:bookId/guide/cancel', requireAdmin, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      res.json({ job: await service.cancel(req.params.bookId) });
    } catch (error) {
      sendError(res, error, 'Book guide cancellation');
    }
  });

  app.delete('/api/book/:bookId/guide', requireAdmin, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      res.json({ success: true, ...(await service.removeBook(req.params.bookId)) });
    } catch (error) {
      sendError(res, error, 'Book guide removal');
    }
  });

  app.get('/api/book-guides/config', requireAdmin, async (_req, res) => {
    try {
      res.json(await service.getConfig());
    } catch (error) {
      sendError(res, error, 'Book guide configuration read');
    }
  });

  app.put('/api/book-guides/config', requireAdmin, async (req, res) => {
    try {
      res.json(await service.configure(req.body || {}));
    } catch (error) {
      sendError(res, error, 'Book guide configuration');
    }
  });

  app.post('/api/book-guides/config/test', requireAdmin, async (_req, res) => {
    try {
      res.json(await service.testConnection());
    } catch (error) {
      sendError(res, error, 'Book guide provider test');
    }
  });

  app.delete('/api/book-guides/config', requireAdmin, async (_req, res) => {
    try {
      res.json(await service.clearConfig());
    } catch (error) {
      sendError(res, error, 'Book guide configuration removal');
    }
  });

  app.get('/api/book-guides/provider/connection', requireAdmin, statusRateLimit, async (_req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await service.providerLoginStatus());
    } catch (error) {
      sendError(res, error, 'Book guide provider connection read');
    }
  });

  app.post('/api/book-guides/provider/login', requireAdmin, loginRateLimit, async (_req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.status(202).json(await service.beginProviderLogin());
    } catch (error) {
      sendError(res, error, 'Book guide provider sign-in');
    }
  });

  app.delete('/api/book-guides/provider/connection', requireAdmin, loginRateLimit, async (_req, res) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await service.disconnectProvider());
    } catch (error) {
      sendError(res, error, 'Book guide provider sign-out');
    }
  });

  return { publicError };
}

module.exports = { ERROR_STATUS, publicError, registerBookGuideRoutes };
