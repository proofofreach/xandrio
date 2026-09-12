'use strict';

// Generic plain-text collapsing helpers.
//
// Scope note: this module holds ONLY domain-free whitespace folding. The
// domain normalizers (normalizeMetadataText, normalizeIsbn, normalizePdfText,
// stop-word removal, TTS casing, …) deliberately stay in their own modules —
// they look similar but have different semantics, and merging them caused
// behavior drift. Migrate here only byte-identical generic bodies.

function collapseUnicodeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

module.exports = { collapseUnicodeText };
