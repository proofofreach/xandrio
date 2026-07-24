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
      return res.status(500).json({
        error: 'Failed to collect diagnostics',
        action: 'Check the service logs, then refresh diagnostics.'
      });
    }
  });
}

module.exports = { registerDiagnosticsRoutes };
