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
  return transitionFromRanges(
    chapterRanges(previousChapters),
    chapterRanges(nextChapters),
    textHash(previousText),
    textHash(nextText)
  );
}

function transitionFromRanges(previousRanges, nextRanges, previousHash, nextHash) {
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
    previousHash,
    nextHash,
    previousRanges,
    nextRanges,
    reusableAudio,
    indexMap: previousRanges.map(previous => {
      const containing = nextRanges.find(next => previous.start >= next.start && previous.start <= next.end);
      return containing?.index ?? 0;
    })
  };
}

// The structure key hashes titles, types and sources only, so a read-time
// re-segmentation that moves text across a boundary keeps the same key while
// saved positions now point at different text. This compact per-chapter text
// identity is recorded beside the key on the book record and is what proves
// that the text under each chapter index stayed put. Entries are
// [normalized length, truncated text hash, estimated duration].
const TEXT_IDENTITY_HASH_LENGTH = 16;
const textIdentityCache = new WeakMap();

function chapterTextIdentity(chapters, structureKey) {
  if (!Array.isArray(chapters) || !structureKey) return null;
  const cached = textIdentityCache.get(chapters);
  if (cached?.structureKey === structureKey) return cached;
  const texts = chapters.map(chapter => normalizedChapterText(chapter?.text));
  const identity = {
    structureKey,
    streamHash: textHash(texts.join(' ')),
    chapters: texts.map((text, index) => [
      text.length,
      textHash(text).slice(0, TEXT_IDENTITY_HASH_LENGTH),
      Math.max(0, Number(chapters[index]?.estimatedDuration) || 0)
    ])
  };
  textIdentityCache.set(chapters, identity);
  return identity;
}

function validTextIdentity(identity) {
  return Boolean(identity && typeof identity === 'object' && typeof identity.structureKey === 'string' &&
    typeof identity.streamHash === 'string' && Array.isArray(identity.chapters) &&
    identity.chapters.every(entry => Array.isArray(entry) && Number.isSafeInteger(entry[0]) && entry[0] >= 0 &&
      typeof entry[1] === 'string'));
}

function sameChapterTextIdentity(left, right) {
  if (!validTextIdentity(left) || !validTextIdentity(right)) return false;
  return left.structureKey === right.structureKey && left.streamHash === right.streamHash &&
    left.chapters.length === right.chapters.length &&
    left.chapters.every((entry, index) => entry[0] === right.chapters[index][0] && entry[1] === right.chapters[index][1]);
}

// Chapter indexes whose text differs between two identities of one book.
function textIdentityChangedIndexes(previous, next) {
  const count = Math.max(previous?.chapters?.length || 0, next?.chapters?.length || 0);
  const changed = [];
  for (let index = 0; index < count; index++) {
    const before = previous?.chapters?.[index];
    const after = next?.chapters?.[index];
    if (!before || !after || before[0] !== after[0] || before[1] !== after[1]) changed.push(index);
  }
  return changed;
}

function rangesFromTextIdentity(identity) {
  let cursor = 0;
  return identity.chapters.map(([length, hash, duration], index) => {
    const range = {
      index,
      start: cursor,
      end: cursor + length,
      length,
      duration: Math.max(0, Number(duration) || 0),
      narrationTextHash: hash
    };
    cursor = range.end + (index < identity.chapters.length - 1 ? 1 : 0);
    return range;
  });
}

// Same contract as buildChapterTransition, from recorded identities instead
// of the previous chapter text, which is no longer available after a re-cut.
function textIdentityTransition(previous, next) {
  if (!validTextIdentity(previous) || !validTextIdentity(next) ||
      !previous.chapters.length || previous.streamHash !== next.streamHash) {
    return {
      safe: false,
      reason: 'narration-text-mismatch',
      previousHash: previous?.streamHash,
      nextHash: next?.streamHash
    };
  }
  return transitionFromRanges(
    rangesFromTextIdentity(previous),
    rangesFromTextIdentity(next),
    previous.streamHash,
    next.streamHash
  );
}

function mappedPosition(position, transition) {
  if (!transition?.safe || !position || typeof position !== 'object') return null;
  const previous = transition.previousRanges?.[Number(position.chapterIndex)];
  if (!previous || previous.length <= 0) return null;
  const oldTimestamp = Math.max(0, Number(position.timestamp) || 0);
  const suppliedCharacterOffset = Number(position.characterOffset);
  const hasCharacterOffset = position.characterOffset !== null && position.characterOffset !== undefined
    && position.characterOffset !== '' && Number.isInteger(suppliedCharacterOffset) && suppliedCharacterOffset >= 0;
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

// One string naming the chapter layout a client may hold: the structure key,
// plus the per-chapter text identity when one is recorded. Downloads compare
// it to refuse audio cut for another layout. Durations are left out; they
// are estimates and do not move text between chapters.
function chapterLayoutKey(structureKey, identity) {
  const key = String(structureKey || '');
  if (!key) return '';
  if (!validTextIdentity(identity) || identity.structureKey !== key) return key;
  const digest = textHash(JSON.stringify(identity.chapters.map(entry => [entry[0], entry[1]])))
    .slice(0, TEXT_IDENTITY_HASH_LENGTH);
  return `${key}~${digest}`;
}

// A same-key remap moves stored positions without changing the structure
// key, so a position held on a device (a checkpoint or a queued write) still
// names the old text. The book records the remap it last applied; a write
// names the remap its client knew. A write from just before the latest remap
// is moved by that remap. Anything older cannot be placed and is stale.
function writeTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? Math.min(ms, Date.now()) : NaN;
}

// `updatedAt` is the write's own stamp. Clients before v231 send no
// `textRemapId` at all, so for them the stamp decides: a position recorded
// after the remap already names the remapped text and must not move again.
function mapTextRemapWrite(book, suppliedRemapId, state, { updatedAt } = {}) {
  const current = String(book?.textRemapId || '');
  const supplied = String(suppliedRemapId || '');
  if (!current || supplied === current) return { state: { ...state, textRemapId: current || undefined } };
  const remap = book?.textRemap;
  if (suppliedRemapId == null && String(remap?.id || '') === current &&
      Number.isFinite(remap?.at) && writeTime(updatedAt) >= remap.at) {
    return { state: { ...state, textRemapId: current } };
  }
  if (!remap || String(remap.id || '') !== current || String(remap.fromId || '') !== supplied ||
      remap.next?.structureKey !== book?.chapterStructureKey) {
    return { stale: true, state: null };
  }
  const mapped = mappedPosition(state, textIdentityTransition(remap.previous, remap.next));
  if (!mapped) return { stale: true, state: null };
  const next = {
    ...state,
    chapterIndex: mapped.chapterIndex,
    timestamp: mapped.timestamp,
    characterOffset: mapped.characterOffset,
    positionApproximate: mapped.approximate || undefined,
    textRemapId: current
  };
  if (!mapped.unchangedIdentity) {
    delete next.chunkIndex;
    delete next.chunkTime;
  }
  return { mapped: true, state: next };
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

// A same-key remap (text drift) cannot use the structure key to tell remapped
// records from unmapped ones, so a replay after an interrupted reconcile
// would move them twice. `remapId` marks each record it has moved, and
// `fromStructureKey` limits the remap to records of the drifted structure.
function remapSkipped(record, options) {
  if (options.fromStructureKey !== undefined && record.chapterStructureKey !== options.fromStructureKey) return true;
  return Boolean(options.remapId) && record.textRemapId === options.remapId;
}

function remapBookPositions(rawStore, bookId, indexMap, chapterStructureKey, options = {}) {
  const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
  if (!store.users || typeof store.users !== 'object') return store;
  for (const userPositions of Object.values(store.users)) {
    const position = userPositions?.[bookId];
    if (!position || typeof position !== 'object') continue;
    if (remapSkipped(position, options)) continue;
    const mapped = Array.isArray(indexMap)
      ? { chapterIndex: indexMap[position.chapterIndex] ?? 0, timestamp: 0, unchangedIdentity: false }
      : mappedPosition(position, indexMap);
    if (!mapped) continue;
    position.chapterIndex = mapped.chapterIndex;
    position.timestamp = mapped.timestamp;
    position.characterOffset = mapped.characterOffset;
    position.positionApproximate = mapped.approximate || undefined;
    position.chapterStructureKey = chapterStructureKey || undefined;
    if (options.remapId) position.textRemapId = options.remapId;
    if (!mapped.unchangedIdentity) {
      position.chunkIndex = undefined;
      position.chunkTime = undefined;
    }
  }
  return store;
}

function remapBookBookmarks(rawStore, bookId, indexMap, chapterStructureKey, options = {}) {
  const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
  if (!store.users || typeof store.users !== 'object') return store;
  for (const userBookmarks of Object.values(store.users)) {
    for (const bookmark of userBookmarks?.[bookId] || []) {
      if (!bookmark || typeof bookmark !== 'object' || remapSkipped(bookmark, options)) continue;
      const mapped = Array.isArray(indexMap)
        ? { chapterIndex: indexMap[bookmark.chapterIndex] ?? 0, timestamp: 0 }
        : mappedPosition(bookmark, indexMap);
      if (!mapped) continue;
      bookmark.chapterIndex = mapped.chapterIndex;
      bookmark.timestamp = mapped.timestamp;
      bookmark.characterOffset = mapped.characterOffset;
      bookmark.positionApproximate = mapped.approximate || undefined;
      bookmark.chapterStructureKey = chapterStructureKey || undefined;
      if (options.remapId) bookmark.textRemapId = options.remapId;
    }
  }
  return store;
}

module.exports = {
  buildChapterIndexMap,
  buildChapterTransition,
  chapterLayoutKey,
  chapterTextIdentity,
  mapTextRemapWrite,
  sameChapterTextIdentity,
  textIdentityChangedIndexes,
  textIdentityTransition,
  mappedPosition,
  textHash,
  remapBookPositions,
  remapBookBookmarks
};
