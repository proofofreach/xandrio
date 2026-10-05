import { apiGet, apiSend, getCurrentUserId } from './api.js';
import { showToast } from './ui/toast.js';
import { readJSON, writeJSON } from './util/storage.js';

const CLIENT_SETTINGS_KEY = 'xandrio_client_settings';
const DEFAULTS = {
  skipIntervalSeconds: 15,
  defaultSpeed: null,
  progressDisplayMode: 'elapsed',
  defaultSearchSources: ['standardebooks', 'gutenberg'],
  smartRewindEnabled: true,
  rollingOfflineEnabled: true
};

const ALLOWED_SKIP_INTERVALS = new Set([10, 15, 30]);
const ALLOWED_PROGRESS_MODES = new Set(['elapsed', 'remaining']);
const ALLOWED_SEARCH_SOURCES = new Set(['standardebooks', 'gutenberg', 'annas', 'zlibrary', 'internetarchive', 'opds']);

let settings = { ...DEFAULTS, ...readLocalSettings() };
let loadPromise = null;
let loadGeneration = 0;
let editRevision = 0;
const editedAt = new Map();
const pendingSaves = new Map();

function sanitize(source = {}) {
  const next = {};
  if (ALLOWED_SKIP_INTERVALS.has(Number(source.skipIntervalSeconds))) {
    next.skipIntervalSeconds = Number(source.skipIntervalSeconds);
  }
  if (source.defaultSpeed === null) {
    next.defaultSpeed = null;
  } else if (source.defaultSpeed !== undefined) {
    const speed = Number(source.defaultSpeed);
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 3) next.defaultSpeed = speed;
  }
  if (ALLOWED_PROGRESS_MODES.has(source.progressDisplayMode)) {
    next.progressDisplayMode = source.progressDisplayMode;
  }
  if (Array.isArray(source.defaultSearchSources)) {
    const sources = [...new Set(source.defaultSearchSources.filter(id => ALLOWED_SEARCH_SOURCES.has(id)))];
    if (sources.length > 0) next.defaultSearchSources = sources;
  }
  if (typeof source.smartRewindEnabled === 'boolean') {
    next.smartRewindEnabled = source.smartRewindEnabled;
  }
  if (typeof source.rollingOfflineEnabled === 'boolean') {
    next.rollingOfflineEnabled = source.rollingOfflineEnabled;
  }
  return next;
}

function readLocalSettings() {
  return sanitize(readJSON(CLIENT_SETTINGS_KEY, {}));
}

function writeLocalSettings() {
  writeJSON(CLIENT_SETTINGS_KEY, settings);
}

function emitChange(key) {
  document.dispatchEvent(new CustomEvent('xandrio:client-settings', {
    detail: { key, settings: { ...settings } }
  }));
}

export async function loadClientSettings(options = {}) {
  if (options.force) loadPromise = null;
  if (loadPromise) return loadPromise;
  const generation = ++loadGeneration;
  const startedAtRevision = editRevision;
  const userId = getCurrentUserId();
  loadPromise = (async () => {
    settings = options.preferLocal === false ? { ...DEFAULTS } : { ...DEFAULTS, ...readLocalSettings() };
    try {
      const data = await apiGet('/api/settings/client');
      if (generation !== loadGeneration || userId !== getCurrentUserId()) return { ...settings };
      const remote = sanitize(data.settings || {});
      // Profile loading may finish after the listener has made a new choice.
      // Merge untouched preferences while preserving every newer local edit.
      for (const key of Object.keys(remote)) {
        if ((editedAt.get(key) || 0) > startedAtRevision) delete remote[key];
      }
      settings = { ...settings, ...remote };
      writeLocalSettings();
      emitChange('*');
    } catch (err) {
      console.warn('Client settings unavailable; using local fallback:', err);
    }
    return { ...settings };
  })();
  return loadPromise;
}

export function getClientSettings() {
  return { ...settings };
}

export function getSkipInterval() {
  return settings.skipIntervalSeconds || DEFAULTS.skipIntervalSeconds;
}

export function getDefaultSpeed() {
  return settings.defaultSpeed;
}

export function getProgressDisplayMode() {
  return settings.progressDisplayMode === 'remaining' ? 'remaining' : 'elapsed';
}

export function getDefaultSearchSources() {
  return Array.isArray(settings.defaultSearchSources)
    ? settings.defaultSearchSources.slice()
    : DEFAULTS.defaultSearchSources.slice();
}

export function isSmartRewindEnabled() {
  return settings.smartRewindEnabled !== false;
}

export function isRollingOfflineEnabled() {
  return settings.rollingOfflineEnabled !== false;
}

export function setClientSetting(key, value) {
  const sanitized = sanitize({ [key]: value });
  if (!(key in sanitized)) return;
  editedAt.set(key, ++editRevision);
  settings = { ...settings, ...sanitized };
  writeLocalSettings();
  emitChange(key);
  const userId = getCurrentUserId();
  // Preserve the order of choices on the server, including after a failed save.
  // A queued write must never follow the browser into a different profile.
  const previous = pendingSaves.get(userId) || Promise.resolve();
  const save = previous.then(() => {
    if (userId !== getCurrentUserId()) return;
    return apiSend('PUT', '/api/settings/client', { settings: sanitized });
  }).catch(err => {
    console.warn('Failed to save client setting:', err);
    if (userId === getCurrentUserId()) showToast('Setting saved on this device only', 'error');
  }).finally(() => {
    if (pendingSaves.get(userId) === save) pendingSaves.delete(userId);
  });
  pendingSaves.set(userId, save);
}
