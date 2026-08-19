// Book ids are used directly as property keys (books[bookId]) and as filename
// stems in the cache directory. The leading-character rule already excludes
// '__proto__', but 'constructor', 'prototype' and the Object.prototype method
// names pass the character class while resolving to inherited members, so an
// existence check like `if (books[bookId])` sees a truthy value for a book
// that does not exist.
const UNSAFE_OBJECT_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  'tostring', 'valueof', 'hasownproperty', 'isprototypeof',
  'propertyisenumerable', 'tolocalestring'
]);

function isSafeBookId(value) {
  if (typeof value !== 'string') return false;
  if (UNSAFE_OBJECT_KEYS.has(value.toLowerCase())) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function parseNonNegativeInteger(value) {
  // Number(''), Number(null) and Number([]) are all 0, so a missing or
  // structurally wrong parameter silently became a valid index 0.
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

module.exports = {
  isSafeBookId,
  parseNonNegativeInteger
};
