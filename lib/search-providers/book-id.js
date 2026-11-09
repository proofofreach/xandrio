const crypto = require('crypto');

// isSafeBookId (lib/request-guards.js) admits at most 128 characters.
const MAX_BOOK_ID_CHARS = 128;

/**
 * The book id of a provider result whose native identifier may hold
 * characters a book id cannot.
 *
 * Providers used to sanitize the identifier and cut it to a fixed length, so
 * two long identifiers sharing a prefix became one id, and a long provider
 * prefix could push the id past the 128-character limit. An identifier that
 * fits keeps exactly its old id, so every book imported under one is still
 * found; one that does not fit is cut to make room for a hash of the whole
 * identifier.
 */
function providerBookId(prefix, nativeId, legacyMaxChars) {
  const raw = String(nativeId || '');
  const sanitized = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const legacy = `${prefix}${sanitized}`;
  if (sanitized.length <= legacyMaxChars && legacy.length <= MAX_BOOK_ID_CHARS) return legacy;
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
  const room = Math.max(0, MAX_BOOK_ID_CHARS - prefix.length - digest.length - 1);
  return `${prefix}${sanitized.slice(0, room).replace(/_+$/, '')}-${digest}`;
}

module.exports = { MAX_BOOK_ID_CHARS, providerBookId };
