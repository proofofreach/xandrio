const crypto = require('crypto');
const { collapseUnicodeText } = require('./text-normalize');

function normalizedTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

function normalizedChapterText(value) {
  return collapseUnicodeText(value);
}

function textHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function chapterRanges(chapters = []) {
  let cursor = 0;
  return chapters.map((chapter, index) => {
    const text = normalizedChapterText(chapter?.text);
    const range = {
      index,
      start: cursor,
      end: cursor + text.length,
      length: text.length,
      duration: Math.max(0, Number(chapter?.estimatedDuration) || 0),
      narrationTextHash: textHash(text)
    };
    cursor = range.end + (index < chapters.length - 1 ? 1 : 0);
    return range;
  });
}

function buildChapterTransition(previousChapters = [], nextChapters = []) {
  // Chapter boundaries are derived structure, not narration. Compare the
  // continuous normalized text stream so a safe split/merge can be rebuilt.
  const previousText = previousChapters.map(chapter => normalizedChapterText(chapter?.text)).join(' ');
  const nextText = nextChapters.map(chapter => normalizedChapterText(chapter?.text)).join(' ');
  if (!previousText || previousText !== nextText) {
    return {
      safe: false,
      reason: 'narration-text-mismatch',
      previousHash: textHash(previousText),
      nextHash: textHash(nextText)
    };
  }
  const previousRanges = chapterRanges(previousChapters);
  const nextRanges = chapterRanges(nextChapters);
  const previousHashCounts = new Map();
  const nextHashCounts = new Map();
  for (const range of previousRanges) {
    previousHashCounts.set(range.narrationTextHash, (previousHashCounts.get(range.narrationTextHash) || 0) + 1);
  }
  for (const range of nextRanges) {
    nextHashCounts.set(range.narrationTextHash, (nextHashCounts.get(range.narrationTextHash) || 0) + 1);
  }
  const reusableAudio = {};
  for (const previous of previousRanges) {
    const matches = nextRanges.filter(next => next.narrationTextHash === previous.narrationTextHash);
    if (previous.length > 0 &&
        previousHashCounts.get(previous.narrationTextHash) === 1 &&
        nextHashCounts.get(previous.narrationTextHash) === 1 &&
        matches.length === 1) {
      reusableAudio[previous.index] = matches[0].index;
    }
  }
  return {
    safe: true,
    previousHash: textHash(previousText),
    nextHash: textHash(nextText),
    previousRanges,
    nextRanges,
    reusableAudio,
    indexMap: previousRanges.map(previous => {
      const containing = nextRanges.find(next => previous.start >= next.start && previous.start <= next.end);
      return containing?.index ?? 0;
    })
  };
}

function mappedPosition(position, transition) {
  if (!transition?.safe || !position || typeof position !== 'object') return null;
  const previous = transition.previousRanges?.[Number(position.chapterIndex)];
  if (!previous || previous.length <= 0) return null;
  const oldTimestamp = Math.max(0, Number(position.timestamp) || 0);
  const suppliedCharacterOffset = Number(position.characterOffset);
  const hasCharacterOffset = Number.isInteger(suppliedCharacterOffset) && suppliedCharacterOffset >= 0;
  const ratio = previous.duration > 0 ? Math.min(1, oldTimestamp / previous.duration) : 0;
  const offset = previous.start + (hasCharacterOffset
    ? Math.min(previous.length, suppliedCharacterOffset)
    : Math.round(previous.length * ratio));
  const next = transition.nextRanges.find(range => offset >= range.start && offset <= range.end) ||
    transition.nextRanges[transition.nextRanges.length - 1];
  if (!next || next.length <= 0) return null;
  const nextRatio = Math.max(0, Math.min(1, (offset - next.start) / next.length));
  const unchangedIdentity = Number(transition.reusableAudio?.[previous.index]) === next.index;
  return {
    chapterIndex: next.index,
    timestamp: unchangedIdentity ? oldTimestamp : (next.duration > 0 ? next.duration * nextRatio : 0),
    characterOffset: Math.max(0, Math.min(next.length, offset - next.start)),
    approximate: Boolean(position.positionApproximate) || !hasCharacterOffset,
    unchangedIdentity
  };
}

function buildChapterIndexMap(previousChapters = [], nextChapters = []) {
  const byTitle = new Map();
  nextChapters.forEach((chapter, index) => {
    const key = normalizedTitle(chapter.title);
    if (key && !byTitle.has(key)) byTitle.set(key, index);
  });

  return previousChapters.map((chapter, oldIndex) => {
    const exact = byTitle.get(normalizedTitle(chapter.title));
    if (Number.isInteger(exact)) return exact;

    const page = Number(chapter.sourceAnchor?.page || chapter.pageStart);
    if (Number.isFinite(page)) {
      const containing = nextChapters.findIndex(candidate =>
        Number(candidate.pageStart) <= page && Number(candidate.pageEnd || candidate.pageStart) >= page
      );
      if (containing >= 0) return containing;
      let nearest = -1;
      let distance = Infinity;
      nextChapters.forEach((candidate, index) => {
        const candidatePage = Number(candidate.sourceAnchor?.page || candidate.pageStart);
        if (!Number.isFinite(candidatePage)) return;
        const candidateDistance = Math.abs(candidatePage - page);
        if (candidateDistance < distance) {
          nearest = index;
          distance = candidateDistance;
        }
      });
      if (nearest >= 0) return nearest;
    }

    if (nextChapters.length === 0) return 0;
    const relative = previousChapters.length <= 1 ? 0 : oldIndex / (previousChapters.length - 1);
    return Math.min(nextChapters.length - 1, Math.round(relative * Math.max(0, nextChapters.length - 1)));
  });
}

function remapBookPositions(rawStore, bookId, indexMap, chapterStructureKey) {
  const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
  if (!store.users || typeof store.users !== 'object') return store;
  for (const userPositions of Object.values(store.users)) {
    const position = userPositions?.[bookId];
    if (!position || typeof position !== 'object') continue;
    const mapped = Array.isArray(indexMap)
      ? { chapterIndex: indexMap[position.chapterIndex] ?? 0, timestamp: 0, unchangedIdentity: false }
      : mappedPosition(position, indexMap);
    if (!mapped) continue;
    position.chapterIndex = mapped.chapterIndex;
    position.timestamp = mapped.timestamp;
    position.characterOffset = mapped.characterOffset;
    position.positionApproximate = mapped.approximate || undefined;
    position.chapterStructureKey = chapterStructureKey || undefined;
    if (!mapped.unchangedIdentity) {
      position.chunkIndex = undefined;
      position.chunkTime = undefined;
    }
  }
  return store;
}

function remapBookBookmarks(rawStore, bookId, indexMap, chapterStructureKey) {
  const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
  if (!store.users || typeof store.users !== 'object') return store;
  for (const userBookmarks of Object.values(store.users)) {
    for (const bookmark of userBookmarks?.[bookId] || []) {
      const mapped = Array.isArray(indexMap)
        ? { chapterIndex: indexMap[bookmark.chapterIndex] ?? 0, timestamp: 0 }
        : mappedPosition(bookmark, indexMap);
      if (!mapped) continue;
      bookmark.chapterIndex = mapped.chapterIndex;
      bookmark.timestamp = mapped.timestamp;
      bookmark.characterOffset = mapped.characterOffset;
      bookmark.positionApproximate = mapped.approximate || undefined;
      bookmark.chapterStructureKey = chapterStructureKey || undefined;
    }
  }
  return store;
}

module.exports = {
  buildChapterIndexMap,
  buildChapterTransition,
  mappedPosition,
  textHash,
  remapBookPositions,
  remapBookBookmarks
};
