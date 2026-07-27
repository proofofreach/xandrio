function normalizedTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
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
    position.chapterIndex = indexMap[position.chapterIndex] ?? 0;
    position.timestamp = 0;
    position.chapterStructureKey = chapterStructureKey || undefined;
    position.chunkIndex = undefined;
    position.chunkTime = undefined;
  }
  return store;
}

function remapBookBookmarks(rawStore, bookId, indexMap) {
  const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
  if (!store.users || typeof store.users !== 'object') return store;
  for (const userBookmarks of Object.values(store.users)) {
    for (const bookmark of userBookmarks?.[bookId] || []) {
      bookmark.chapterIndex = indexMap[bookmark.chapterIndex] ?? 0;
      bookmark.timestamp = 0;
    }
  }
  return store;
}

module.exports = {
  buildChapterIndexMap,
  remapBookPositions,
  remapBookBookmarks
};
