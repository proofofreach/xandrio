const { recoverOfflinePackage } = require('../offline-package-recovery');

function registerOfflineRecoveryRoutes(app, { requireAdmin, bookMutationLocks, loadInput,
  audioPackage, readyPackages, afterRecovery }) {
  const operations = new Set();
  let closing = false;
  app.post('/api/admin/offline/preparation/:bookId/recover', requireAdmin, (req, res) => {
    if (closing) return res.status(503).json({ error: 'Server is shutting down' });
    if (operations.size) return res.status(429).json({ error: 'An offline recovery is already running' });
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    const write = event => {
      controller.signal.throwIfAborted();
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      res.write(`${JSON.stringify(event)}\n`);
    };
    const operation = { controller, promise: null };
    operations.add(operation);
    operation.promise = bookMutationLocks.withBookMutationLock(req.params.bookId, async () => {
      controller.signal.throwIfAborted();
      const result = await recoverOfflinePackage({ bookId: req.params.bookId,
        sourceVoice: req.body?.sourceVoice, sourceVariantKey: req.body?.sourceVariantKey,
        acceptLegacy: req.body?.acceptUnverifiedSourceAssociation === true,
        signal: controller.signal, loadInput, audioPackage, readyPackages, onProgress: write });
      controller.signal.throwIfAborted();
      const preparation = await afterRecovery(result.bookId);
      write({ result: { ...result, preparation } });
      res.end();
    }).catch(error => {
      if (controller.signal.aborted || res.destroyed) return;
      if (!res.headersSent) res.status(error instanceof TypeError ? 400 : 409);
      write({ error: error.message });
      res.end();
    }).finally(() => {
      res.removeListener('close', abort);
      operations.delete(operation);
    });
  });
  return {
    async close() {
      closing = true;
      for (const operation of operations) operation.controller.abort();
      await Promise.allSettled([...operations].map(operation => operation.promise));
    }
  };
}

module.exports = { registerOfflineRecoveryRoutes };
