function integerSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isInteger)
    .filter(value => value >= 0));
}

export function planRollingOfflineWindow({
  currentChapter,
  chapterCount,
  cachedChapters = [],
  chaptersAhead = 2,
  chaptersBehind = 1
}) {
  const count = Math.max(0, Number.isInteger(chapterCount) ? chapterCount : 0);
  const cached = integerSet(cachedChapters);
  if (!count) {
    return { retain: [], prepare: [], evict: [...cached].sort((a, b) => a - b) };
  }

  const current = Math.min(count - 1, Math.max(0, Number(currentChapter) || 0));
  const first = Math.max(0, current - Math.max(0, Number(chaptersBehind) || 0));
  const last = Math.min(count - 1, current + Math.max(0, Number(chaptersAhead) || 0));
  const retain = [];
  for (let index = first; index <= last; index++) retain.push(index);
  const retained = new Set(retain);

  return {
    retain,
    prepare: retain.filter(index => !cached.has(index)),
    evict: [...cached].filter(index => !retained.has(index)).sort((a, b) => a - b)
  };
}
