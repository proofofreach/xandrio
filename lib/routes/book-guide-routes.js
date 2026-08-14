'use strict';

const { isSafeBookId: defaultIsSafeBookId } = require('../request-guards');

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
  BOOK_GUIDE_CERTIFICATION_MISSING_OR_FAILED: 409,
  BOOK_GUIDE_CERTIFICATION_PROVENANCE_MISMATCH: 409
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
    BOOK_GUIDE_EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED: 'Confirm that the book may be sent to PPQ.ai for processing.',
    BOOK_GUIDE_EXTERNAL_PROCESSING_ACKNOWLEDGEMENT_REQUIRED: 'Acknowledge external book processing when configuring PPQ.ai.',
    BOOK_GUIDE_PROVIDER_URL_INVALID: 'Book Guides require the official PPQ.ai API endpoint.',
    BOOK_GUIDE_MODEL_REQUIRED: 'Choose a supported PPQ.ai study-guide model.',
    BOOK_GUIDE_CATEGORY_INVALID: 'Choose nonfiction or remove the study-guide tag.',
    BOOK_GUIDE_BOOK_NOT_FOUND: 'Book not found',
    BOOK_GUIDE_NOT_FOUND: 'Book guide not found',
    BOOK_GUIDE_ANCHOR_NOT_FOUND: 'Guide anchor not found',
    BOOK_GUIDE_DISABLED: 'Book guides are disabled.',
    BOOK_GUIDE_UNAVAILABLE: 'Book guides are not configured or available.',
    BOOK_GUIDE_LANGUAGE_UNSUPPORTED: 'Book guides currently support English nonfiction only.',
    BOOK_GUIDE_NONFICTION_TAG_REQUIRED: 'Tag this title as nonfiction before creating a study guide.',
    BOOK_GUIDE_SOURCE_CHANGED: 'The book changed during guide generation. Try again.',
    BOOK_GUIDE_ANCHOR_STALE: 'This source link no longer resolves exactly.',
    BOOK_GUIDE_MODEL_UNAVAILABLE: 'The configured study-guide model is unavailable.',
    BOOK_GUIDE_MODEL_DIGEST_INVALID: 'The study-guide model identity is invalid.',
    BOOK_GUIDE_MODEL_CHANGED: 'The configured model changed. Review and save the configuration again.',
    BOOK_GUIDE_MODEL_SUBSTITUTED: 'PPQ.ai returned a different model than the configured model.',
    BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING: 'Add a PPQ.ai API key in Study Guide settings.',
    BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID: 'The PPQ.ai API key was rejected.',
    BOOK_GUIDE_PROVIDER_FUNDS_REQUIRED: 'The PPQ.ai account has insufficient credit.',
    BOOK_GUIDE_PROVIDER_RESPONSE_INVALID: 'PPQ.ai returned an invalid study-guide response.',
    BOOK_GUIDE_PROVIDER_UNAVAILABLE: 'PPQ.ai is unavailable. Try again later.',
    BOOK_GUIDE_CERTIFICATION_MISSING_OR_FAILED: 'The configured models do not have a passing local benchmark certificate.',
    BOOK_GUIDE_CERTIFICATION_PROVENANCE_MISMATCH: 'The benchmark certificate does not match the configured models and guide recipe.'
  };
  return { status, code, message: messages[code] || 'Book guide operation failed.' };
}

function registerBookGuideRoutes(app, {
  service,
  requireAdmin,
  setBookCategory = null,
  isSafeBookId = defaultIsSafeBookId,
  log = console
} = {}) {
  if (!app || !service || typeof requireAdmin !== 'function') {
    throw new TypeError('Book guide routes require app, service, and requireAdmin');
  }

  function validBook(req, res) {
    if (isSafeBookId(req.params.bookId)) return true;
    res.status(400).json({ error: 'Invalid book identifier', code: 'BOOK_GUIDE_INVALID_BOOK_ID' });
    return false;
  }

  function sendError(res, error, label) {
    const safe = publicError(error);
    if (safe.status >= 500) log.error(`${label} failed: ${safe.code}`);
    return res.status(safe.status).json({ error: safe.message, code: safe.code });
  }

  app.get('/api/book/:bookId/guide/anchors/:anchorId/context', async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      res.json(await service.getAnchorContext(req.params.bookId, req.params.anchorId));
    } catch (error) {
      sendError(res, error, 'Book guide context');
    }
  });

  app.get('/api/book/:bookId/guide', async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      const result = await service.get(req.params.bookId);
      const canManage = req.user?.role === 'admin';
      const { generation: _privateGeneration, ...publicResult } = result;
      res.json({
        ...(canManage ? result : publicResult),
        canManage,
        canGenerate: Boolean(result.canGenerate && canManage)
      });
    } catch (error) {
      sendError(res, error, 'Book guide read');
    }
  });

  app.post('/api/book/:bookId/guide', requireAdmin, async (req, res) => {
    if (!validBook(req, res)) return;
    try {
      const job = await service.start(req.params.bookId);
      res.status(202).json({ status: job?.status || 'pending', job });
    } catch (error) {
      sendError(res, error, 'Book guide generation');
    }
  });

  app.put('/api/book/:bookId/guide/category', requireAdmin, async (req, res) => {
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

  return { publicError };
}

module.exports = { ERROR_STATUS, publicError, registerBookGuideRoutes };
