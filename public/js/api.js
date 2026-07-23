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

let promptingForToken = false;
async function handleUnauthorized() {
  if (promptingForToken) return;
  promptingForToken = true;
  const token = window.prompt('This server requires an access token (XANDRIO_TOKEN). Enter it to continue:');
  if (token && token.trim()) {
    try {
      const response = await __originalFetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() })
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
      window.alert('The access token was not accepted.');
    } catch {
      window.alert('Could not contact the server to start a session.');
    }
  }
  promptingForToken = false;
}

const __originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await __originalFetch(input, init);
  if (response.status === 401) void handleUnauthorized();
  return response;
};

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
  return {
    'X-Xandrio-User-Id': getCurrentUserId(),
    'X-Xandrio-Device-Id': getCurrentDeviceId(),
    'X-Xandrio-Device-Name': getCurrentDeviceName(),
    ...extra
  };
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
