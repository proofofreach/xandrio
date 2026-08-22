// Sign-in gate. Shown before the app boots when the server requires
// authentication, and raised over the running app when a session expires
// (the api.js fetch wrapper dispatches xandrio:unauthorized on any 401).
//
// In bootstrap mode — authentication required but no accounts created yet —
// the same form accepts the shared access token instead of a username.

import { login, loginWithToken } from '../api.js';

let gate, form, usernameInput, passwordInput, errorLine, submitBtn, offlineStatus;
let tokenMode = false;
let onSignedIn = null;
let signingIn = false;

function setError(message) {
  if (!errorLine) return;
  errorLine.textContent = message || '';
  errorLine.style.display = message ? 'block' : 'none';
}

function setTokenMode(enabled) {
  tokenMode = enabled;
  const usernameRow = document.getElementById('login-username-row');
  if (usernameRow) usernameRow.style.display = enabled ? 'none' : 'block';
  if (passwordInput) {
    passwordInput.placeholder = enabled ? 'Access token' : 'Password';
    passwordInput.autocomplete = enabled ? 'off' : 'current-password';
  }
  const hint = document.getElementById('login-hint');
  if (hint) {
    hint.textContent = enabled
      ? 'Enter the access token (XANDRIO_TOKEN) for this server.'
      : 'Sign in with your Xandrio account.';
  }
}

function updateConnectivityState() {
  const offline = navigator.onLine === false;
  if (offlineStatus) offlineStatus.hidden = !offline;
  if (!submitBtn) return;
  submitBtn.disabled = signingIn || offline;
  submitBtn.textContent = signingIn
    ? 'Signing in…'
    : offline
    ? 'Reconnect to sign in'
    : 'Sign In';
}

export function initLogin(options = {}) {
  onSignedIn = options.onSignedIn || (() => window.location.reload());
  gate = document.getElementById('login-view');
  form = document.getElementById('login-form');
  usernameInput = document.getElementById('login-username');
  passwordInput = document.getElementById('login-password');
  errorLine = document.getElementById('login-error');
  submitBtn = document.getElementById('login-submit');
  offlineStatus = document.getElementById('login-offline-status');
  if (!gate || !form) return;

  // This runs before app.js checks authentication. The authenticated app owns
  // offline storage and playback; the gate only needs connection state so a
  // reader is never offered an impossible sign-in while disconnected.
  window.removeEventListener('online', updateConnectivityState);
  window.removeEventListener('offline', updateConnectivityState);
  window.addEventListener('online', updateConnectivityState);
  window.addEventListener('offline', updateConnectivityState);
  updateConnectivityState();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (navigator.onLine === false) {
      updateConnectivityState();
      return;
    }
    setError('');
    signingIn = true;
    updateConnectivityState();
    try {
      if (tokenMode) {
        await loginWithToken(passwordInput.value.trim());
      } else {
        await login(usernameInput.value.trim(), passwordInput.value);
      }
      passwordInput.value = '';
      hideLoginGate();
      onSignedIn();
    } catch (err) {
      setError(err.message || 'Sign-in failed');
    } finally {
      signingIn = false;
      updateConnectivityState();
    }
  });

  document.addEventListener('xandrio:unauthorized', () => {
    // Session expired mid-use: pause whatever is playing so the position
    // checkpoint survives, then raise the gate over the running app.
    options.onSessionExpired?.();
    showLoginGate();
  });
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.tokenMode] Bootstrap: no accounts exist yet, the
 *   shared token is still the credential.
 */
export function showLoginGate(options = {}) {
  if (!gate) return;
  setTokenMode(Boolean(options.tokenMode));
  setError('');
  updateConnectivityState();
  gate.classList.add('active');
  document.body.classList.add('login-gate-open');
  (tokenMode ? passwordInput : usernameInput)?.focus();
}

export function hideLoginGate() {
  if (!gate) return;
  gate.classList.remove('active');
  document.body.classList.remove('login-gate-open');
}
