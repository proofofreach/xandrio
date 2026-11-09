const { mappedPosition } = require('./chapter-reprocess');

function currentStructureKey(book) {
  return String(book?.chapterStructureKey || '');
}

function transitionForWrite({ bookId, suppliedStructureKey, book, transitions }) {
  const supplied = String(suppliedStructureKey || '');
  const current = currentStructureKey(book);
  if (!current || supplied === current) return { current: true, transition: null };

  const pending = book?.metadataRefreshReconciliation?.positions;
  const record = pending?.type === 'relabel' && pending.previousStructureKey === supplied &&
      pending.structureKey === current
    ? { previousStructureKey: supplied, nextStructureKey: current, transition: pending.transition }
    : transitions?.[bookId];
  if (!record || String(record.previousStructureKey || '') !== supplied ||
      String(record.nextStructureKey || '') !== current) {
    return { current: false, transition: null };
  }
  return { current: false, transition: record.transition || null };
}

// No chapter is a day long. Measured durations are not narrator-scoped, so a
// different voice may run longer than the recorded value; the slack absorbs
// that while still rejecting milliseconds sent as seconds.
const MAX_CHAPTER_TIMESTAMP_SECONDS = 24 * 60 * 60;
const TIMESTAMP_DURATION_FACTOR = 2;
const TIMESTAMP_DURATION_SLACK_SECONDS = 60;

function knownChapterCount(book) {
  const count = Number(book?.chapterCount);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function chapterTimestampLimit(book, chapterIndex) {
  const measured = Number(book?.chapterDurations?.[chapterIndex]);
  const total = Number(book?.totalDuration);
  const known = Number.isFinite(measured) && measured > 0
    ? measured
    : (Number.isFinite(total) && total > 0 ? total : null);
  if (known === null) return MAX_CHAPTER_TIMESTAMP_SECONDS;
  return Math.min(MAX_CHAPTER_TIMESTAMP_SECONDS,
    known * TIMESTAMP_DURATION_FACTOR + TIMESTAMP_DURATION_SLACK_SECONDS);
}

// Forward-only progress compares stored positions by chapter and timestamp,
// so one stored value past the end of the book outranks every real write on
// every device. Every state written in the current structure must lie inside
// the book.
function positionOutsideBook(state, book) {
  const chapterIndex = Number(state?.chapterIndex);
  const timestamp = Number(state?.timestamp);
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 0) return 'chapter';
  const chapterCount = knownChapterCount(book);
  if (chapterCount !== null && chapterIndex >= chapterCount) return 'chapter';
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > chapterTimestampLimit(book, chapterIndex)) {
    return 'timestamp';
  }
  return null;
}

function mapStateWriteToCurrent(input) {
  const result = mapStateToCurrentStructure(input);
  if (!result.state) return result;
  const violation = positionOutsideBook(result.state, input.book);
  return violation ? { invalid: violation, state: null } : result;
}

function mapStateToCurrentStructure({ bookId, suppliedStructureKey, book, transitions, state }) {
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
  if (match.transition.safe && match.transition.metadataOnly) {
    return { mapped: true, state: { ...state, chapterStructureKey: structureKey } };
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

module.exports = { mapStateWriteToCurrent, positionOutsideBook, transitionForWrite };
