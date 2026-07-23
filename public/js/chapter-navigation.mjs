export function positionMatchesChapterStructure(position, book) {
  const expected = String(book?.chapterStructureKey || '');
  if (!expected) return true;
  return String(position?.chapterStructureKey || '') === expected;
}

function positionUpdatedAt(position) {
  if (typeof position?.updatedAt === 'number') return position.updatedAt;
  if (typeof position?.updatedAtMs === 'number') return position.updatedAtMs;
  const parsed = Date.parse(position?.updatedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function comparePlaybackPositions(left, right) {
  const chapterDelta = (Number(left?.chapterIndex) || 0) - (Number(right?.chapterIndex) || 0);
  if (chapterDelta) return chapterDelta;
  return (Number(left?.timestamp) || 0) - (Number(right?.timestamp) || 0);
}

export function shouldAllowBackwardReconciliation(localPosition, serverPosition) {
  if (!localPosition || !serverPosition) return false;
  return positionUpdatedAt(localPosition) >= positionUpdatedAt(serverPosition) &&
    comparePlaybackPositions(localPosition, serverPosition) < 0;
}

export async function navigateChapterSelection(options = {}) {
  const {
    nextChapter,
    chapterCount,
    getCurrentChapter,
    checkpointPlayback,
    savePosition,
    loadChapter,
    commitImmediately = false,
    seekToSeconds
  } = options;

  if (!Number.isInteger(nextChapter) || nextChapter < 0 || nextChapter >= chapterCount) {
    return { changed: false, invalid: true };
  }

  const previousChapter = getCurrentChapter();
  const isBackward = nextChapter < previousChapter;
  const isForward = nextChapter > previousChapter;

  checkpointPlayback({ force: true });
  await savePosition({ force: true });
  await loadChapter(nextChapter, {
    provisionalForward: isForward && !commitImmediately,
    commitImmediately: isBackward || commitImmediately,
    ...(Number.isFinite(seekToSeconds) ? { seekToSeconds } : {})
  });

  if (getCurrentChapter() !== nextChapter) return { changed: false, stale: true };

  if (isBackward || commitImmediately) {
    checkpointPlayback({ force: true });
    await savePosition({ allowBackward: isBackward, force: true });
  }

  return { changed: nextChapter !== previousChapter, isBackward, isForward };
}
