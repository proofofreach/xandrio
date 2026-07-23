function validDurations(durations) {
  if (!Array.isArray(durations) || durations.length === 0) return null;
  const values = durations.map(Number);
  return values.every(value => Number.isFinite(value) && value > 0) ? values : null;
}

export function bookTimelinePosition(durations, chapterIndex, chapterTime = 0) {
  const values = validDurations(durations);
  if (!values) return null;

  const index = Math.max(0, Math.min(values.length - 1, Number(chapterIndex) || 0));
  const elapsedBefore = values.slice(0, index).reduce((sum, value) => sum + value, 0);
  const elapsedInChapter = Math.max(0, Math.min(values[index], Number(chapterTime) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const elapsed = Math.min(total, elapsedBefore + elapsedInChapter);

  return {
    elapsed,
    remaining: Math.max(0, total - elapsed),
    total,
    percent: (elapsed / total) * 100
  };
}

export function bookTimelineSeekTarget(durations, percent) {
  const values = validDurations(durations);
  if (!values) return null;

  const total = values.reduce((sum, value) => sum + value, 0);
  const clampedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const target = total * clampedPercent / 100;
  let elapsedBefore = 0;

  for (let chapterIndex = 0; chapterIndex < values.length; chapterIndex += 1) {
    const chapterEnd = elapsedBefore + values[chapterIndex];
    if (target < chapterEnd || chapterIndex === values.length - 1) {
      return {
        chapterIndex,
        chapterTime: Math.max(0, Math.min(values[chapterIndex], target - elapsedBefore)),
        elapsed: target,
        total,
        percent: clampedPercent
      };
    }
    elapsedBefore = chapterEnd;
  }

  return null;
}
