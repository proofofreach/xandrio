// API access + sync identity.
//
// Importing this module installs the 401 access-token interceptor as a side
// effect, so it must be imported before any fetch happens (app.js imports it
// at the top; module evaluation order guarantees this runs first).

export const API_BASE = window.location.origin;

// ---- Access token (XANDRIO_TOKEN) ----
// The token is exchanged once for a server-signed, HttpOnly session cookie.
// It is intentionally not kept in localStorage or a script-readable cookie:
// the browser will still send the session for fetches, <audio> Range requests,
// and service-worker playback.
localStorage.removeItem('xandrioToken'); // Remove the legacy script-readable token.
document.cookie = 'xandrio_token=; path=/; max-age=0; SameSite=Lax';

// ---- Authenticated account ----
// Populated from /api/auth/status during boot and after login. When an
// account session exists the server derives identity from the session
// cookie; the legacy X-Xandrio-User-Id sync header is then omitted.
let currentUser = null;

export function getCurrentUser() {
  return currentUser;
}

export function setCurrentUser(user) {
  currentUser = user && user.id ? user : null;
}

export async function fetchAuthStatus() {
  const response = await window.fetch(`${API_BASE}/api/auth/status`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const status = await response.json();
  setCurrentUser(status.user);
  return status;
}

// A 401 anywhere means the session expired or was revoked. The login view
// listens for this event and raises the sign-in gate; the flag keeps a burst
// of failing requests from dispatching a storm of events.
let unauthorizedSignaled = false;
function handleUnauthorized() {
  if (unauthorizedSignaled) return;
  unauthorizedSignaled = true;
  document.dispatchEvent(new CustomEvent('xandrio:unauthorized'));
}

export function resetUnauthorizedSignal() {
  unauthorizedSignaled = false;
}

const __originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await __originalFetch(input, init);
  if (response.status === 401) handleUnauthorized();
  return response;
};

export async function login(username, password) {
  const response = await __originalFetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Sign-in failed');
  setCurrentUser(data.user);
  resetUnauthorizedSignal();
  return data.user || null;
}

// Bootstrap-mode login (no accounts yet, XANDRIO_TOKEN still the credential).
export async function loginWithToken(token) {
  const response = await __originalFetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  if (!response.ok) throw new Error('The access token was not accepted.');
  resetUnauthorizedSignal();
}

export async function logout() {
  await __originalFetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'same-origin' });
  setCurrentUser(null);
}

// ---- Sync identity (user/device headers on every position/sync call) ----

const SYNC_USER_KEY = 'xandrio_sync_user_id';
const SYNC_DEVICE_KEY = 'xandrio_sync_device_id';
const SYNC_DEVICE_NAME_KEY = 'xandrio_sync_device_name';
const DEFAULT_SYNC_USER_ID = 'default';

function createLocalSyncId(prefix) {
  const bytes = new Uint8Array(8);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  }
  return `${prefix}_${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function getCurrentUserId() {
  if (currentUser?.id) return currentUser.id;
  const stored = localStorage.getItem(SYNC_USER_KEY);
  if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) return stored;
  localStorage.setItem(SYNC_USER_KEY, DEFAULT_SYNC_USER_ID);
  return DEFAULT_SYNC_USER_ID;
}

export function setCurrentUserId(userId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(userId || ''))) return false;
  localStorage.setItem(SYNC_USER_KEY, userId);
  return true;
}

// "Forget this device" — drop back to the default (unsynced) profile.
export function resetSyncUser() {
  localStorage.setItem(SYNC_USER_KEY, DEFAULT_SYNC_USER_ID);
}

export function isDefaultSyncUser(profileId) {
  return !profileId || profileId === DEFAULT_SYNC_USER_ID;
}

export function getCurrentDeviceId() {
  const stored = localStorage.getItem(SYNC_DEVICE_KEY);
  if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) return stored;
  const deviceId = createLocalSyncId('dev');
  localStorage.setItem(SYNC_DEVICE_KEY, deviceId);
  return deviceId;
}

export function getCurrentDeviceName() {
  const stored = localStorage.getItem(SYNC_DEVICE_NAME_KEY);
  if (stored) return stored;
  const name = /iPhone|iPad|Android/i.test(navigator.userAgent)
    ? 'Mobile'
    : 'Browser';
  localStorage.setItem(SYNC_DEVICE_NAME_KEY, name);
  return name;
}

export function syncHeaders(extra = {}) {
  const headers = {
    'X-Xandrio-Device-Id': getCurrentDeviceId(),
    'X-Xandrio-Device-Name': getCurrentDeviceName(),
    ...extra
  };
  // Account sessions carry identity in the cookie; the self-asserted user
  // header remains only for trusted-LAN instances without accounts.
  if (!currentUser) headers['X-Xandrio-User-Id'] = getCurrentUserId();
  return headers;
}

export async function apiSend(method, path, body = null, options = {}) {
  const { headers: optionHeaders = {}, ...fetchOptions } = options;
  const headers = syncHeaders(optionHeaders);
  const init = { ...fetchOptions, method, headers };
  if (body !== null && body !== undefined) {
    if (body instanceof FormData) {
      delete headers['Content-Type'];
      init.body = body;
    } else {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = headers['Content-Type'] === 'application/json' ? JSON.stringify(body) : body;
    }
  }
  const response = await fetch(`${API_BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    Object.assign(error, data, { status: response.status });
    throw error;
  }
  return data;
}

export function apiGet(path, options = {}) {
  return apiSend('GET', path, null, options);
}
