const crypto = require('crypto');
const fsDefault = require('fs').promises;
const path = require('path');
const { isSafeBookId } = require('./request-guards');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chapterArtifactPattern(bookId, chapterIndex) {
  return new RegExp(
    `^${escapeRegExp(bookId)}(?:_tts[a-f0-9]{10}|_offline_[a-f0-9]{16})?_ch${chapterIndex}(?:_|\\.)`
  );
}

function destinationName(bookId, name, from, to) {
  const pattern = new RegExp(
    `^(${escapeRegExp(bookId)}(?:_tts[a-f0-9]{10}|_offline_[a-f0-9]{16})?_ch)${from}((?:_|\\.).*)$`
  );
  return name.replace(pattern, (_match, prefix, suffix) => `${prefix}${to}${suffix}`);
}

function transactionKey(bookId, transition) {
  return crypto.createHash('sha256').update(JSON.stringify([
    bookId,
    transition?.previousHash,
    transition?.nextHash,
    transition?.reusableAudio
  ])).digest('hex').slice(0, 20);
}

function uniqueAudioMappings(transition) {
  const pairs = Object.entries(transition?.reusableAudio || {})
    .map(([from, to]) => ({ from: Number(from), to: Number(to) }))
    .filter(pair => Number.isInteger(pair.from) && pair.from >= 0 && Number.isInteger(pair.to) && pair.to >= 0);
  const targetCounts = new Map();
  for (const pair of pairs) targetCounts.set(pair.to, (targetCounts.get(pair.to) || 0) + 1);
  return pairs.filter(pair => targetCounts.get(pair.to) === 1);
}

function affectedIndexes(transition, mappings) {
  const stable = new Set(mappings.filter(pair => pair.from === pair.to).map(pair => pair.from));
  const affected = new Set();
  for (const range of transition?.previousRanges || []) {
    if (!stable.has(range.index)) affected.add(range.index);
  }
  for (const range of transition?.nextRanges || []) {
    if (!stable.has(range.index)) affected.add(range.index);
  }
  return [...affected].sort((left, right) => left - right);
}

function createChapterAudioReconciler({
  cacheDir,
  workers = () => [],
  invalidateCache = async () => [],
  removeGenerationClaims = async () => {},
  fs = fsDefault
} = {}) {
  if (!cacheDir) throw new TypeError('Chapter audio reconciliation requires a cache directory');

  function activeWorkers() {
    return [...new Set(typeof workers === 'function' ? workers() : workers)].filter(Boolean);
  }

  async function removeArtifacts(bookId, indexes) {
    const entries = await fs.readdir(cacheDir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    await Promise.all(entries
      .filter(name => indexes.some(index => chapterArtifactPattern(bookId, index).test(name)))
      .map(name => fs.unlink(path.join(cacheDir, name)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }

  async function invalidateAffected(bookId, indexes, { cancelAll = false } = {}) {
    const currentWorkers = activeWorkers();
    if (cancelAll) {
      await Promise.allSettled(currentWorkers.map(worker =>
        Promise.resolve().then(() => worker.cancelBook?.(bookId))
      ));
    }
    await Promise.allSettled([
      removeGenerationClaims(bookId, indexes),
      invalidateCache(indexes.map(chapterIndex => ({ bookId, chapterIndex, fromChunkIndex: 0 })))
    ]);
    await removeArtifacts(bookId, indexes);
  }

  async function reconcile({ bookId, transition, nextChapters = [], language = 'en' } = {}) {
    if (!isSafeBookId(bookId)) throw new TypeError('Invalid book identifier');
    if (!transition?.safe) return { moved: [], affectedIndexes: [] };

    const mappings = uniqueAudioMappings(transition);
    const moved = mappings.filter(pair => pair.from !== pair.to);
    const affected = affectedIndexes(transition, mappings);
    if (affected.length === 0) return { moved, affectedIndexes: affected };

    const manifestPath = path.join(cacheDir, `.rebuild-audio-${transactionKey(bookId, transition)}.json`);
    let manifest;
    try {
      const currentWorkers = activeWorkers();
      await Promise.all(currentWorkers.flatMap(worker => affected.map(chapterIndex =>
        worker.quiesceChapterAllVariants?.(bookId, chapterIndex, {}, 0)
      )));
      await removeGenerationClaims(bookId, affected);

      const reusePlans = (await Promise.all(currentWorkers.flatMap(worker => moved.map(async pair => {
        const chapter = nextChapters[pair.to];
        if (!chapter?.text || !worker.chapterArtifactReusePlan) return null;
        return worker.chapterArtifactReusePlan(bookId, pair.to, chapter.text, language);
      })))).filter(Boolean);
      const expectedFingerprints = new Map(reusePlans.flatMap(plan =>
        (plan.artifacts || []).map(item => [item.outputPath, item.fingerprint])
      ));

      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const entries = await fs.readdir(cacheDir).catch(readError => {
          if (readError.code === 'ENOENT') return [];
          throw readError;
        });
        const items = [];
        for (const pair of moved) {
          const sourcePattern = chapterArtifactPattern(bookId, pair.from);
          for (const name of entries.filter(candidate => sourcePattern.test(candidate) && /\.(?:mp3|wav)$/i.test(candidate))) {
            const markerName = `${name}.narration-artifact.json`;
            if (!entries.includes(markerName)) continue;
            let marker;
            try {
              marker = JSON.parse(await fs.readFile(path.join(cacheDir, markerName), 'utf8'));
            } catch {
              continue;
            }
            // The fingerprint binds text, voice/model, output settings, and
            // chunking policy. Text identity alone cannot authorize reuse.
            if (marker?.version !== 1 || !/^[a-f0-9]{64}$/.test(String(marker.fingerprint || ''))) continue;
            const targetAudioPath = path.join(cacheDir, destinationName(bookId, name, pair.from, pair.to));
            if (expectedFingerprints.get(targetAudioPath) !== marker.fingerprint) continue;
            for (const reusableName of [name, markerName]) {
              const targetName = destinationName(bookId, reusableName, pair.from, pair.to);
              items.push({
                sourcePath: path.join(cacheDir, reusableName),
                stagePath: path.join(cacheDir, `.rebuild-audio-${transactionKey(bookId, transition)}-${items.length}`),
                targetPath: path.join(cacheDir, targetName)
              });
            }
          }
        }
        manifest = { version: 1, bookId, affected, items };
        const temporary = `${manifestPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(manifest));
        await fs.rename(temporary, manifestPath);
      }

      // Copy rather than rename so a failure before the durable book commit
      // could never consume the old artifact. The manifest makes every step
      // repeatable after a process crash.
      for (const item of manifest.items || []) {
        const stageExists = await fs.access(item.stagePath).then(() => true, () => false);
        const targetExists = await fs.access(item.targetPath).then(() => true, () => false);
        const sourceExists = await fs.access(item.sourcePath).then(() => true, () => false);
        if (!stageExists && sourceExists) await fs.copyFile(item.sourcePath, item.stagePath);
        if (!stageExists && !sourceExists && !targetExists) {
          throw new Error('Reusable audio source and staged copy are both missing');
        }
      }

      await invalidateCache(affected.map(chapterIndex => ({
        bookId,
        chapterIndex,
        fromChunkIndex: 0
      })));

      await removeArtifacts(bookId, affected);

      for (const item of manifest.items || []) {
        const stageExists = await fs.access(item.stagePath).then(() => true, () => false);
        if (stageExists) await fs.rename(item.stagePath, item.targetPath);
      }
      await Promise.all(reusePlans.map(plan => fs.writeFile(plan.hashPath, plan.textHash)));
      for (const pair of moved) {
        const chapter = nextChapters[pair.to];
        if (!chapter?.text) continue;
        await Promise.all(currentWorkers.map(worker => worker.indexChapterArtifacts?.(
          bookId,
          pair.to,
          chapter.text,
          language
        )));
      }
      await fs.unlink(manifestPath).catch(() => {});
      return { moved, affectedIndexes: affected };
    } catch (error) {
      if (error.simulateCrash) throw error;
      await Promise.all((manifest?.items || []).map(item => fs.unlink(item.stagePath).catch(() => {})));
      await fs.unlink(manifestPath).catch(() => {});
      await invalidateAffected(bookId, affected, { cancelAll: true }).catch(cleanupError => {
        error.cleanupError = cleanupError;
      });
      throw error;
    }
  }

  return { invalidateAffected, reconcile };
}

module.exports = {
  affectedIndexes,
  chapterArtifactPattern,
  createChapterAudioReconciler,
  uniqueAudioMappings
};
