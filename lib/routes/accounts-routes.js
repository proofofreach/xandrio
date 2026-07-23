// Admin account management. Every route is mounted behind requireAdmin;
// the CLI (scripts/manage-accounts.js) remains available for headless use
// and for bootstrapping without a browser.

const MIN_PASSWORD_LENGTH = 8;

function sendStorageError(res, error, message) {
  console.error('Account management failed:', error);
  return res.status(500).json({ error: message });
}

function registerAccountRoutes(app, { accounts, sessionStore, requireAdmin }) {
  app.get('/api/accounts', requireAdmin, async (req, res) => {
    try {
      res.json({ accounts: await accounts.list() });
    } catch (err) {
      sendStorageError(res, err, 'Failed to list accounts');
    }
  });

  app.post('/api/accounts', requireAdmin, async (req, res) => {
    try {
      const { username, password, displayName, role } = req.body || {};
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const account = await accounts.createAccount({
        username,
        password,
        displayName,
        role: role === 'admin' ? 'admin' : 'member'
      });
      res.json({ success: true, account });
    } catch (err) {
      if (/already exists|Username must be/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      sendStorageError(res, err, 'Failed to create account');
    }
  });

  // Admin reset — no current password required; revokes the account's
  // sessions so a lost or compromised device is signed out immediately.
  app.post('/api/accounts/:id/password', requireAdmin, async (req, res) => {
    try {
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      const changed = await accounts.changePassword(req.params.id, newPassword);
      if (!changed) return res.status(404).json({ error: 'Account not found' });
      await sessionStore.destroyAllForUser(req.params.id);
      res.json({ success: true });
    } catch (err) {
      sendStorageError(res, err, 'Failed to reset password');
    }
  });

  app.post('/api/accounts/:id/disabled', requireAdmin, async (req, res) => {
    try {
      const disabled = Boolean(req.body?.disabled);
      const target = await accounts.findById(req.params.id);
      if (!target) return res.status(404).json({ error: 'Account not found' });
      if (disabled) {
        if (req.user?.id === target.id) {
          return res.status(400).json({ error: 'You cannot disable your own account' });
        }
        // Never lock the instance out of administration entirely.
        const enabledAdmins = (await accounts.list()).filter(account => account.role === 'admin' && !account.disabled);
        if (target.role === 'admin' && enabledAdmins.length <= 1) {
          return res.status(400).json({ error: 'Cannot disable the last admin account' });
        }
      }
      await accounts.setDisabled(target.id, disabled);
      if (disabled) await sessionStore.destroyAllForUser(target.id);
      res.json({ success: true });
    } catch (err) {
      sendStorageError(res, err, 'Failed to update account');
    }
  });
}

module.exports = { registerAccountRoutes };
