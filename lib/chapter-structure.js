const crypto = require('crypto');

const STRUCTURE_KEY_VERSION = 1;

function normalizedPart(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function chapterStructureKey(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const identity = chapters.map((chapter, index) => [
    index,
    normalizedPart(chapter?.type),
    normalizedPart(chapter?.title),
    normalizedPart(chapter?.sourceHref || chapter?.sourceSpineId)
  ]);
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20);
  return `v${STRUCTURE_KEY_VERSION}-${digest}`;
}

function positionMatchesChapterStructure(position, book) {
  const expected = normalizedPart(book?.chapterStructureKey);
  if (!expected) return true;
  return normalizedPart(position?.chapterStructureKey) === expected;
}

module.exports = {
  STRUCTURE_KEY_VERSION,
  chapterStructureKey,
  positionMatchesChapterStructure
};
