const { isSafeBookId } = require('../request-guards');
const { PronunciationError } = require('../pronunciation-repair');

function ruleLocation(req) {
  const scope = req.body?.scope || req.query?.scope;
  const bookId = req.body?.bookId || req.query?.bookId;
  if (scope === 'book' && !isSafeBookId(bookId)) {
    throw new PronunciationError('Invalid book identifier');
  }
  return { scope, bookId };
}

function sendError(res, error) {
  if (error instanceof PronunciationError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error('Pronunciation request failed:', error);
  return res.status(500).json({ error: 'Failed to manage pronunciation rules' });
}

function registerPronunciationRoutes(app, { pronunciationService }) {
  if (!pronunciationService) throw new Error('pronunciationService is required');

  app.get('/api/pronunciations', async (req, res) => {
    try {
      const bookId = req.query.bookId;
      if (bookId && !isSafeBookId(bookId)) throw new PronunciationError('Invalid book identifier');
      res.json(await pronunciationService.list(bookId));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/pronunciations', async (req, res) => {
    try {
      const location = ruleLocation(req);
      const result = await pronunciationService.create({ ...location, input: req.body });
      res.status(201).json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/pronunciations/:id', async (req, res) => {
    try {
      const location = ruleLocation(req);
      const result = await pronunciationService.update({ ...location, id: req.params.id, input: req.body });
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/pronunciations/:id', async (req, res) => {
    try {
      const location = ruleLocation(req);
      const result = await pronunciationService.remove({ ...location, id: req.params.id });
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });
}

module.exports = { registerPronunciationRoutes };
