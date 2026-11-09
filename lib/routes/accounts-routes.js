// Admin account management. Every route is mounted behind requireAdmin;
// the CLI (scripts/manage-accounts.js) remains available for headless use
// and for bootstrapping without a browser.

const { badRequest, notFound, storageError } = require('../http-error');
const { LAST_ADMIN_ERROR_CODE } = require('../accounts');

const MIN_PASSWORD_LENGTH = 8;

function sendStorageError(res, error, message) {
  return storageError(res, error, message, 'Account management failed:');
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
        return badRequest(res, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
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
        return badRequest(res, err.message);
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
        return badRequest(res, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const changed = await accounts.changePassword(req.params.id, newPassword);
      if (!changed) return notFound(res, 'Account not found');
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
      if (!target) return notFound(res, 'Account not found');
      if (disabled && req.user?.id === target.id) {
        return badRequest(res, 'You cannot disable your own account');
      }
      // Never lock the instance out of administration entirely: the store
      // refuses to disable the last enabled admin inside its own update.
      await accounts.setDisabled(target.id, disabled);
      if (disabled) await sessionStore.destroyAllForUser(target.id);
      res.json({ success: true });
    } catch (err) {
      if (err.code === LAST_ADMIN_ERROR_CODE) {
        return badRequest(res, 'Cannot disable the last admin account');
      }
      sendStorageError(res, err, 'Failed to update account');
    }
  });
}

module.exports = { registerAccountRoutes };
