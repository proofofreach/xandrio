const { OPERATOR_POLICY_VERSION, operatorPolicyStatus } = require('../operator-policy');
const { badRequest, storageError } = require('../http-error');

function registerOperatorPolicyRoutes(app, {
  settingsFile,
  jsonStore,
  now = () => new Date().toISOString(),
  updateSettingsCache = () => {}
}) {
  app.get('/api/legal/operator-policy', async (_req, res) => {
    try {
      const settings = await jsonStore.load(settingsFile, {});
      res.json(operatorPolicyStatus(settings));
    } catch (error) {
      return storageError(res, error, 'Failed to load operator policy', 'Operator policy storage failed:');
    }
  });

  app.put('/api/legal/operator-policy', async (req, res) => {
    try {
      const { acknowledged, unverifiedSourcesEnabled } = req.body || {};
      if (acknowledged !== true || typeof unverifiedSourcesEnabled !== 'boolean') {
        return badRequest(res, 'acknowledged must be true and unverifiedSourcesEnabled must be a boolean');
      }
      let updatedSettings;
      const status = await jsonStore.update(settingsFile, settings => {
        settings.operatorPolicy = {
          version: OPERATOR_POLICY_VERSION,
          acknowledgedAt: operatorPolicyStatus(settings).acknowledgedAt || now(),
          unverifiedSourcesEnabled
        };
        updatedSettings = settings;
        return operatorPolicyStatus(settings);
      });
      updateSettingsCache(updatedSettings);
      res.json(status);
    } catch (error) {
      return storageError(res, error, 'Failed to save operator policy', 'Operator policy storage failed:');
    }
  });
}

module.exports = { registerOperatorPolicyRoutes };
