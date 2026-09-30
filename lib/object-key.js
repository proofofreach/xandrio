// Persisted JSON maps become plain objects on every load. Keep client-supplied
// identifiers away from inherited properties, even when their spelling varies.
const UNSAFE_OBJECT_KEYS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype'
].map(key => key.toLowerCase()));

function isUnsafeObjectKey(value) {
  return UNSAFE_OBJECT_KEYS.has(String(value).toLowerCase());
}

module.exports = { isUnsafeObjectKey };
