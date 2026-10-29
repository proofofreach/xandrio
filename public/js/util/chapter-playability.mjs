// The one rule for whether a chapter has narration. The browser imports this
// module directly and the server loads it through lib/chapter-playability.js,
// so chapter selection, auto-advance, resume and server playback routes cannot
// disagree about which chapters exist as audio.
//
// Structural sections (part dividers, covers and contents pages marked `empty`
// at import) and chapters without text are never narrated. Reading and
// chapter-list display do not use this rule; they show every section.
//
// TTS can still find a structurally playable chapter unspeakable (for example
// a heading with no prose). Playback routes report that as a typed
// `unplayable` result, and the client then records the index as unplayable and
// passes it to these helpers through `isPlayable`.

export function isPlayableChapter(chapter) {
  if (!chapter || typeof chapter !== 'object') return false;
  if (chapter.empty) return false;
  if (chapter.type === 'part') return false;
  // Structure-only records (no `text` field) are judged by structure alone.
  // A chapter whose text is present must contain something besides spaces.
  if (chapter.text === undefined || chapter.text === null) return true;
  return String(chapter.text).trim().length > 0;
}

function playabilityTest(isPlayable) {
  return typeof isPlayable === 'function' ? isPlayable : isPlayableChapter;
}

/**
 * First playable chapter strictly after (direction 1) or before (direction -1)
 * `fromIndex`, or null when none remains in that direction.
 */
export function findPlayableChapterIndex(chapters, fromIndex, direction = 1, isPlayable = isPlayableChapter) {
  const list = Array.isArray(chapters) ? chapters : [];
  const test = playabilityTest(isPlayable);
  const step = direction < 0 ? -1 : 1;
  const start = Number.isInteger(fromIndex) ? fromIndex : (step > 0 ? -1 : list.length);
  for (let index = start + step; index >= 0 && index < list.length; index += step) {
    if (test(list[index], index)) return index;
  }
  return null;
}

/**
 * `index` when it is playable. Otherwise the nearest playable chapter in
 * `direction`, then in the opposite direction. Null when the book has no
 * playable chapter at all.
 */
export function resolvePlayableChapterIndex(chapters, index, direction = 1, isPlayable = isPlayableChapter) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) return null;
  const test = playabilityTest(isPlayable);
  const bounded = Math.max(0, Math.min(list.length - 1, Number.isInteger(index) ? index : 0));
  if (test(list[bounded], bounded)) return bounded;
  return findPlayableChapterIndex(list, bounded, direction, test)
    ?? findPlayableChapterIndex(list, bounded, direction < 0 ? 1 : -1, test);
}
