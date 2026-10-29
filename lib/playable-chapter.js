'use strict';

// Structural entries retain their book indexes, but do not occupy audio time.
// Short dialogue is valid speech; avoid imposing a narration-length threshold.
function isPlayableChapter(chapter) {
  return !chapter?.empty && /[\p{L}\p{N}]/u.test(String(chapter?.text || ''));
}

module.exports = { isPlayableChapter };
