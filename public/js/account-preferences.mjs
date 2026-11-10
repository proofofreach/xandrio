// Device-local preferences, partitioned by account.
//
// The device keeps a copy of a few profile preferences so they apply before
// the profile loads and while offline. One unpartitioned copy let the next
// account on a shared device start with, and save over, the previous
// account's choices. Every key here takes the storage scope explicitly
// (api.js getOfflineStorageScopeId), the same scope playback checkpoints use.

import { deviceHasOtherScope } from './playback-checkpoints.mjs';

const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Bases of the partitioned keys. Builds before partitioning wrote each base
// alone, with no owner.
export const ACCOUNT_PREFERENCE_BASES = ['xandrio_client_settings', 'xandrio_playback_speed'];

function storage() {
  return globalThis.localStorage || null;
}

function validScope(scopeId) {
  const scope = String(scopeId || '');
  return LOCAL_ID_PATTERN.test(scope) ? scope : null;
}

function parse(raw) {
  try {
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function accountPreferenceKey(base, scopeId) {
  const scope = validScope(scopeId);
  return scope && ACCOUNT_PREFERENCE_BASES.includes(base) ? `${base}:${scope}` : null;
}

function otherScopeHasPreferences(scope) {
  const store = storage();
  if (!store) return false;
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    for (const base of ACCOUNT_PREFERENCE_BASES) {
      if (key?.startsWith(`${base}:`) && key.slice(base.length + 1) !== scope) return true;
    }
  }
  return false;
}

// An unattributed value is adopted only while nothing on the device shows a
// second account, so it can only have been written by this one. Otherwise its
// owner is unknowable and it is dropped.
function claimLegacy(base, scope, key) {
  const store = storage();
  const raw = store?.getItem(base);
  if (raw == null) return null;
  try {
    if (deviceHasOtherScope(scope) || otherScopeHasPreferences(scope)) return null;
    store.setItem(key, raw);
    return parse(raw);
  } catch {
    return null;
  } finally {
    store.removeItem(base);
  }
}

/**
 * The value this scope saved under base, or null. `claimLegacy` lets the
 * caller adopt a pre-partitioning value once the account is settled
 * (api.js canClaimLegacyOfflineStorage).
 */
export function readAccountPreference(base, scopeId, { claimLegacy: claim = false } = {}) {
  const key = accountPreferenceKey(base, scopeId);
  if (!key) return null;
  let raw = null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw != null) return parse(raw);
  return claim ? claimLegacy(base, validScope(scopeId), key) : null;
}

export function writeAccountPreference(base, scopeId, value) {
  const key = accountPreferenceKey(base, scopeId);
  if (!key) return false;
  try {
    storage()?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeAccountPreference(base, scopeId) {
  const key = accountPreferenceKey(base, scopeId);
  try {
    if (key) storage()?.removeItem(key);
  } catch {
    // Storage is best effort.
  }
}
