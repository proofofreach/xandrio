const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('./write-file-atomic');
const { isSafeBookId } = require('./request-guards');
const { packageVariantKey } = require('./offline-audio-package');
const { applyPronunciationRules } = require('./pronunciation-repair');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifactPattern = /^sha256-[a-f0-9]{64}$/;

function sourceTextRevision({ book, chapters }, rules = []) {
  return digest([
    String(book?.addedAt || ''),
    String(book?.language || 'en').trim().toLowerCase(),
    chapters.map(chapter => [applyPronunciationRules(String(chapter?.text || ''), rules), Boolean(chapter?.empty)])
  ]);
}

function packageProfile(identity) {
  return String(identity.sourceVariantKey || '').replace(/:(?:prep|audio)\d+(?=:|$)/g, '');
}

function validIdentity(identity) {
  return identity && typeof identity.sourceVoice === 'string' && identity.sourceVoice.length > 0 &&
    typeof identity.sourceVariantKey === 'string' && identity.sourceVariantKey.length > 0 &&
    identity.packageVariantKey === packageVariantKey(identity.sourceVariantKey) &&
    Number.isInteger(identity.sourceChunkSize) && identity.sourceChunkSize > 0 && identity.bitrateKbps === 48;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Offline package retention was cancelled'), { name: 'AbortError' });
}

function createOfflineReadyPackages({ cacheDir, audioPackage }) {
  function keyFor(input) {
    if (!isSafeBookId(input.bookId) || !validIdentity(input.identity) || !Array.isArray(input.chapters)) {
      throw new TypeError('Invalid retained offline package request');
    }
    const revision = sourceTextRevision(input, input.rules);
    const key = digest([revision, input.identity.sourceVoice, packageProfile(input.identity)]);
    return { revision, file: path.join(cacheDir, `${input.bookId}_offline-ready_${key}.json`) };
  }

  async function inspectAll(input, identity, expected = null) {
    const artifacts = Array(input.chapters.length).fill(null);
    let bytes = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, input.chapters.length) }, async () => {
      while (next < input.chapters.length) {
        const index = next++;
        throwIfAborted(input.signal);
        if (input.chapters[index].empty) continue;
        const item = await audioPackage.inspectChapter({ bookId: input.bookId, chapterIndex: index,
          sourceVariantKey: identity.sourceVariantKey });
        if (!item?.ready || !artifactPattern.test(item.artifactId) || item.variantKey !== identity.packageVariantKey ||
          (expected && expected[index] !== item.artifactId)) {
          throw new Error('Retained offline package is not complete');
        }
        artifacts[index] = item.artifactId;
        bytes += Math.max(0, Number(item.size) || 0);
      }
    }));
    throwIfAborted(input.signal);
    return { artifacts, bytes };
  }

  async function remember(input) {
    throwIfAborted(input.signal);
    const { revision, file } = keyFor(input);
    const { artifacts, bytes } = await inspectAll(input, input.identity);
    await input.beforePublish?.();
    throwIfAborted(input.signal);
    const identity = Object.fromEntries(['sourceVoice', 'sourceVariantKey', 'sourceChunkSize',
      'packageVariantKey', 'bitrateKbps'].map(key => [key, input.identity[key]]));
    await writeFileAtomic(file, JSON.stringify({ schemaVersion: 1, bookId: input.bookId,
      sourceTextRevision: revision, identity, artifacts,
      associationSource: input.associationSource === 'operator' ? 'operator' : 'preparation' }), {
      beforeRename: async () => {
        throwIfAborted(input.signal);
        await input.beforePublish?.();
        throwIfAborted(input.signal);
      }
    });
    throwIfAborted(input.signal);
    return { ...identity, sourceTextRevision: revision, retainedPackageRevision: digest([revision, identity.packageVariantKey, artifacts]),
      retainedArtifacts: artifacts, retainedPackageBytes: bytes, retained: true };
  }

  async function select(input) {
    const { revision, file } = keyFor(input);
    const current = { ...input.identity, sourceTextRevision: revision, retainedPackageRevision: '', retained: false };
    let record;
    try { record = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { return current; }
    if (record?.schemaVersion !== 1 || record.bookId !== input.bookId || record.sourceTextRevision !== revision ||
      !validIdentity(record.identity) || record.identity.sourceVoice !== input.identity.sourceVoice ||
      packageProfile(record.identity) !== packageProfile(input.identity) ||
      !Array.isArray(record.artifacts) || record.artifacts.length !== input.chapters.length ||
      record.artifacts.some((artifact, index) => input.chapters[index].empty
        ? artifact !== null : !artifactPattern.test(artifact))) return current;
    let inspection;
    try { inspection = await inspectAll(input, record.identity, record.artifacts); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      return current;
    }
    return { ...record.identity, sourceTextRevision: revision, retainedPackageRevision: digest([revision, record.identity.packageVariantKey, record.artifacts]),
      retainedArtifacts: record.artifacts.slice(), retainedPackageBytes: inspection.bytes, retained: true };
  }

  return { select, remember };
}

module.exports = { createOfflineReadyPackages, sourceTextRevision, packageProfile };
