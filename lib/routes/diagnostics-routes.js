const { sendError } = require('../http-error');

function registerDiagnosticsRoutes(app, {
  collectDiagnostics,
  requireAdmin
}) {
  if (typeof collectDiagnostics !== 'function') throw new TypeError('collectDiagnostics is required');
  if (typeof requireAdmin !== 'function') throw new TypeError('requireAdmin is required');

  app.get('/api/admin/diagnostics', requireAdmin, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      const refreshEngines = req.query.refresh === '1';
      return res.json(await collectDiagnostics({ refreshEngines }));
    } catch (error) {
      console.error('Operator diagnostics failed:', error);
      return sendError(res, 500, 'Failed to collect diagnostics', undefined, {
        action: 'Check the service logs, then refresh diagnostics.'
      });
    }
  });
}

module.exports = { registerDiagnosticsRoutes };
