const { mappedPosition } = require('./chapter-reprocess');

function currentStructureKey(book) {
  return String(book?.chapterStructureKey || '');
}

function transitionForWrite({ bookId, suppliedStructureKey, book, transitions }) {
  const supplied = String(suppliedStructureKey || '');
  const current = currentStructureKey(book);
  if (!current || supplied === current) return { current: true, transition: null };

  const record = transitions?.[bookId];
  if (!record || String(record.previousStructureKey || '') !== supplied ||
      String(record.nextStructureKey || '') !== current) {
    return { current: false, transition: null };
  }
  return { current: false, transition: record.transition || null };
}

function mapStateWriteToCurrent({ bookId, suppliedStructureKey, book, transitions, state }) {
  const match = transitionForWrite({ bookId, suppliedStructureKey, book, transitions });
  const structureKey = book?.chapterStructureKey || undefined;
  if (match.current) {
    return { mapped: false, state: { ...state, chapterStructureKey: structureKey } };
  }
  if (!match.transition) {
    const chapterCount = Math.max(1, Number(book?.chapterCount) || 1);
    return {
      mapped: true,
      approximate: true,
      state: {
        ...state,
        chapterIndex: Math.max(0, Math.min(chapterCount - 1, Number(state?.chapterIndex) || 0)),
        timestamp: 0,
        characterOffset: 0,
        positionApproximate: true,
        chapterStructureKey: structureKey
      }
    };
  }
  const mapped = mappedPosition(state, match.transition);
  if (!mapped) return { stale: true, state: null };
  const next = {
    ...state,
    chapterIndex: mapped.chapterIndex,
    timestamp: mapped.timestamp,
    characterOffset: mapped.characterOffset,
    positionApproximate: mapped.approximate || undefined,
    chapterStructureKey: structureKey
  };
  if (!mapped.unchangedIdentity) {
    delete next.chunkIndex;
    delete next.chunkTime;
  }
  return { mapped: true, state: next };
}

module.exports = { mapStateWriteToCurrent, transitionForWrite };
