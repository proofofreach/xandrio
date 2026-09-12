const { packageVariantKey } = require('./offline-audio-package');
const { sourceTextRevision } = require('./offline-ready-packages');
const { isSafeBookId } = require('./request-guards');

async function recoverOfflinePackage({ bookId, sourceVariantKey, sourceVoice, loadInput, audioPackage, readyPackages,
  signal, acceptLegacy = false, onProgress = () => {} }) {
  if (!isSafeBookId(bookId) || !sourceVoice || !sourceVariantKey?.startsWith(`${sourceVoice}:`)) {
    throw new TypeError('Specify the book, original voice, and its exact source variant');
  }
  const sourceChunkSize = Number(/:chunk(\d+)(?=:|$)/.exec(sourceVariantKey)?.[1]);
  if (!Number.isInteger(sourceChunkSize) || sourceChunkSize < 1) throw new TypeError('Variant has no valid chunk size');
  if (!acceptLegacy) throw new TypeError('Legacy recovery requires --accept-unverified-source-association; it cannot verify the narration recipe');
  const identity = { sourceVoice, sourceVariantKey, sourceChunkSize,
    packageVariantKey: packageVariantKey(sourceVariantKey), bitrateKbps: 48 };
  const input = { ...await loadInput(bookId, identity), bookId, identity };
  const revision = sourceTextRevision(input, input.rules);
  const indexes = input.chapters.flatMap((chapter, index) => chapter.empty ? [] : [index]);
  if (!indexes.length) throw new Error('Book has no narrated chapters');
  for (const chapterIndex of indexes) {
    const item = await audioPackage.inspectChapter({ bookId, chapterIndex, sourceVariantKey });
    if (!item.ready && !item.legacySize) throw new Error(`Original package is missing chapter ${chapterIndex + 1}`);
  }
  const beforePublish = async () => {
    signal?.throwIfAborted();
    const latest = await loadInput(bookId, identity);
    if (latest.book.path !== input.book.path || sourceTextRevision(latest, latest.rules) !== revision) {
      throw new Error('Book or narration input changed during recovery');
    }
  };
  let next = 0;
  let completed = 0;
  let bytes = 0;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let results;
  try {
    results = await Promise.allSettled(Array.from({ length: Math.min(2, indexes.length) }, async () => {
      try {
        while (next < indexes.length) {
          const chapterIndex = indexes[next++];
          controller.signal.throwIfAborted();
          const item = await audioPackage.ensureChapter({ bookId, chapterIndex, sourceVariantKey,
            signal: controller.signal, beforePublish });
          bytes += item.size;
          completed++;
          onProgress({ completed, total: indexes.length, bytes });
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }));
  } finally { signal?.removeEventListener('abort', onAbort); }
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  await readyPackages.remember({ ...input, signal, beforePublish, associationSource: 'operator' });
  return { bookId, title: input.book.title, chapters: indexes.length, bytes,
    packageVariantKey: identity.packageVariantKey, provenance: 'legacy-unverified' };
}


module.exports = { recoverOfflinePackage };
