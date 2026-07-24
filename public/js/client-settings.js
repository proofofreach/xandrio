import { apiGet, apiSend } from './api.js';
import { showToast } from './ui/toast.js';
import { readJSON, writeJSON } from './util/storage.js';

const CLIENT_SETTINGS_KEY = 'xandrio_client_settings';
const DEFAULTS = {
  skipIntervalSeconds: 15,
  defaultSpeed: null,
  progressDisplayMode: 'elapsed',
  defaultSearchSources: ['standardebooks', 'gutenberg']
};

const ALLOWED_SKIP_INTERVALS = new Set([10, 15, 30]);
const ALLOWED_PROGRESS_MODES = new Set(['elapsed', 'remaining']);
const ALLOWED_SEARCH_SOURCES = new Set(['standardebooks', 'gutenberg', 'annas', 'zlibrary', 'internetarchive', 'opds']);

let settings = { ...DEFAULTS, ...readLocalSettings() };
let loadPromise = null;

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
  loadPromise = (async () => {
    settings = options.preferLocal === false ? { ...DEFAULTS } : { ...DEFAULTS, ...readLocalSettings() };
    try {
      const data = await apiGet('/api/settings/client');
      settings = { ...settings, ...sanitize(data.settings || {}) };
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

export function setClientSetting(key, value) {
  const sanitized = sanitize({ [key]: value });
  if (!(key in sanitized)) return;
  settings = { ...settings, ...sanitized };
  writeLocalSettings();
  emitChange(key);
  apiSend('PUT', '/api/settings/client', { settings: { [key]: sanitized[key] } }).catch(err => {
    console.warn('Failed to save client setting:', err);
    showToast('Setting saved on this device only', 'error');
  });
}
