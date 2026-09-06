const crypto = require('node:crypto');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createOfflineTransferManifest({ getBookChapters, chapterStatus, preparationStatus, preparationIdentity }) {
  return async function manifest(bookId) {
    const { chapters } = await getBookChapters(bookId);
    const identity = await preparationIdentity({ bookId });
    const status = await preparationStatus(bookId);
    const textHash = crypto.createHash('sha256');
    for (const chapter of chapters) {
      const text = String(chapter?.text || '');
      textHash.update(String(Buffer.byteLength(text)));
      textHash.update(':');
      textHash.update(text);
      textHash.update(chapter?.empty ? '\u00001' : '\u00000');
    }
    const textRevision = textHash.digest('hex');
    const entries = [];
    const expectedRecipeFingerprints = Array(chapters.length).fill('');
    // Bound file inspection instead of opening one sidecar for every chapter at once.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, chapters.length) }, async () => {
      while (next < chapters.length) {
        const index = next++;
        if (chapters[index].empty) {
          entries[index] = { index, state: 'empty' };
          continue;
        }
        const item = await chapterStatus(bookId, index, identity);
        expectedRecipeFingerprints[index] = String(item?.expectedRecipeFingerprint || '');
        const validReady = item.ready === true &&
          /^sha256-[a-f0-9]{64}$/.test(String(item.artifactId || '')) &&
          item.contentHash === item.artifactId &&
          item.etag === `"${item.artifactId}"` &&
          Number.isInteger(item.size) && item.size > 0 &&
          item.blockSize === 1024 * 1024 &&
          Array.isArray(item.blockHashes) &&
          item.blockHashes.length === Math.ceil(item.size / item.blockSize) &&
          item.blockHashes.every(hash => /^sha256-[a-f0-9]{64}$/.test(String(hash))) &&
          ['verified', 'legacy-unverified'].includes(item.provenance);
        if (!validReady) {
          entries[index] = { index, state: item.errorChunks ? 'error' : 'pending' };
          continue;
        }
        entries[index] = {
          index, state: 'ready', artifactId: item.artifactId,
          size: item.size, contentHash: item.contentHash, etag: item.etag,
          blockSize: item.blockSize, blockHashes: item.blockHashes,
          sourceFingerprint: item.sourceFingerprint || '',
          provenance: item.provenance || 'legacy-unverified',
          mimeType: 'audio/mpeg', variantKey: item.variantKey,
          url: `/api/offline/audio/${encodeURIComponent(bookId)}/${index}` +
            `?variant=${encodeURIComponent(item.variantKey)}&artifact=${encodeURIComponent(item.artifactId)}`
        };
      }
    }));
    const sourceRevision = digest([
      textRevision,
      identity.packageVariantKey,
      expectedRecipeFingerprints
    ]);
    const complete = entries.length > 0 && entries.every(item => ['ready', 'empty'].includes(item.state));
    const bytesPrepared = entries.reduce((sum, item) => sum + (item.size || 0), 0);
    const body = {
      schemaVersion: 1, bookId, sourceRevision,
      packageVariantKey: identity.packageVariantKey,
      state: complete ? 'ready' : status.state === 'ready' ? 'repair-needed' : status.state,
      totalChapters: chapters.length, bytesPrepared,
      bytesTotal: complete ? bytesPrepared : null,
      chapters: entries
    };
    return { ...body, revision: digest(body) };
  };
}

module.exports = { createOfflineTransferManifest };
