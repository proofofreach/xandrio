(function initXandrioOfflineStore(global) {
  'use strict';

  const DB_NAME = 'xandrio-offline-v4';
  const DB_VERSION = 1;
  const BLOCK_SIZE = 1_048_576;
  const LEASE_MS = 15_000;
  const DEFAULT_TIMEOUT_MS = 10_000;
  const SEP = '\u0000';

  const clone = value => value == null ? value : structuredClone(value);
  const scopeKey = (scope, value) => `${String(scope)}${SEP}${String(value)}`;
  const titleKey = (scope, bookId, revision) => `${scopeKey(scope, bookId)}${SEP}${String(revision)}`;
  const chapterKey = (scope, bookId, revision, index) => `${titleKey(scope, bookId, revision)}${SEP}${Number(index)}`;
  const artifactKey = (scope, artifactId) => scopeKey(scope, artifactId);
  const blockKey = (scope, artifactId, index) => `${artifactKey(scope, artifactId)}${SEP}${Number(index)}`;
  const refKey = (scope, artifactId, ownerKind, ownerId) =>
    `${artifactKey(scope, artifactId)}${SEP}${String(ownerKind)}${SEP}${String(ownerId)}`;
  const activeKey = (scope, bookId) => `active${SEP}${scopeKey(scope, bookId)}`;
  const scopeEpochKey = scope => `scope-epoch${SEP}${String(scope)}`;
  const titleEpochKey = (scope, bookId) => `title-epoch${SEP}${scopeKey(scope, bookId)}`;
  const tombstoneKey = (scope, bookId) => `tombstone${SEP}${scopeKey(scope, bookId)}`;
  const validArtifactId = value => /^sha256-[a-f0-9]{64}$/.test(String(value || ''));
  const keyRange = () => global.IDBKeyRange;
  const metadataRange = (scope, artifactId) => keyRange().bound(
    [artifactKey(scope, artifactId), 0, '', 0],
    [artifactKey(scope, artifactId), Number.MAX_SAFE_INTEGER, '\uffff', Number.MAX_SAFE_INTEGER]
  );

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function cursorValues(source, range) {
    return new Promise((resolve, reject) => {
      const values = [];
      const request = source.openCursor(range);
      request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(values);
        values.push({ key: cursor.primaryKey, value: cursor.value });
        cursor.continue();
      };
    });
  }

  function cursorKeys(source, range) {
    return new Promise((resolve, reject) => {
      const keys = [];
      const request = source.openKeyCursor(range);
      request.onerror = () => reject(request.error || new Error('IndexedDB key cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(keys);
        keys.push({ key: cursor.primaryKey, indexKey: cursor.key });
        cursor.continue();
      };
    });
  }

  function txComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => {};
    });
  }

  function withTimeout(promise, timeoutMs, onTimeout) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch {}
          reject(new Error('IndexedDB transaction timed out'));
        }, timeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function createStore(options = {}) {
    const idb = options.indexedDB || global.indexedDB;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const timeoutMs = Math.max(50, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const instanceId = (() => {
      try { return global.crypto.randomUUID(); } catch {}
      try {
        const words = global.crypto.getRandomValues(new Uint32Array(4));
        return Array.from(words, value => value.toString(16).padStart(8, '0')).join('');
      } catch {}
      return Math.random().toString(36).slice(2);
    })();
    let writeSequence = 0;
    let database = null;
    let opening = null;

    async function open() {
      if (database) return database;
      if (opening) return opening;
      if (!idb?.open) throw new Error('IndexedDB is unavailable');
      let abandoned = false;
      const pending = new Promise((resolve, reject) => {
        const request = idb.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('titles')) {
            db.createObjectStore('titles', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('chapters')) {
            const store = db.createObjectStore('chapters', { keyPath: 'key' });
            store.createIndex('scopeArtifact', 'scopeArtifact', { unique: false });
            store.createIndex('scopeBook', 'scopeBook', { unique: false });
          }
          if (!db.objectStoreNames.contains('blocks')) {
            const store = db.createObjectStore('blocks', { keyPath: 'key' });
            store.createIndex('scopeArtifact', 'scopeArtifact', { unique: false });
            store.createIndex('scopeArtifactMeta', ['scopeArtifact', 'index', 'state', 'size'], { unique: false });
          }
          if (!db.objectStoreNames.contains('artifactRefs')) {
            const store = db.createObjectStore('artifactRefs', { keyPath: 'key' });
            store.createIndex('scopeArtifact', 'scopeArtifact', { unique: false });
            store.createIndex('scopeOwner', 'scopeOwner', { unique: false });
          }
          if (!db.objectStoreNames.contains('control')) {
            db.createObjectStore('control', { keyPath: 'key' });
          }
        };
        request.onsuccess = () => {
          const opened = request.result;
          if (abandoned) {
            opened.close();
            return;
          }
          database = opened;
          database.onversionchange = () => {
            database.close();
            database = null;
            opening = null;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
      });
      opening = withTimeout(pending, timeoutMs, () => { abandoned = true; })
        .finally(() => { opening = null; });
      return opening;
    }

    async function transaction(names, mode, operation) {
      const db = await open();
      const tx = db.transaction(names, mode);
      const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
      const completed = txComplete(tx);
      return withTimeout((async () => {
        try {
          const value = await operation(stores, tx);
          await completed;
          return value;
        } catch (error) {
          try { tx.abort(); } catch {}
          await completed.catch(() => {});
          throw error;
        }
      })(), timeoutMs, () => tx.abort());
    }

    async function controlValue(control, key, fallback) {
      const record = await requestResult(control.get(key));
      if (record) return record.value;
      await requestResult(control.put({ key, value: fallback }));
      return fallback;
    }

    async function epochs(control, scope, bookId, create = true) {
      const get = async (key, fallback) => {
        const record = await requestResult(control.get(key));
        if (record) return record.value;
        if (create) await requestResult(control.put({ key, value: fallback }));
        return fallback;
      };
      return {
        scopeEpoch: Number(await get(scopeEpochKey(scope), 1)) || 1,
        titleEpoch: Number(await get(titleEpochKey(scope, bookId), 1)) || 1
      };
    }

    async function requireFence(stores, fence, scope, bookId, { allowTombstone = false } = {}) {
      if (!fence || !fence.ownerId || !fence.scope || !fence.bookId) {
        throw new Error('A current offline storage fence is required');
      }
      if (String(fence.scope) !== String(scope) || String(fence.bookId) !== String(bookId)) {
        throw new Error('Offline storage fence does not match its target');
      }
      const lease = await requestResult(stores.control.get('lease'));
      const leaseValue = lease?.value;
      if (
        !leaseValue || leaseValue.ownerId !== fence.ownerId ||
        Number(leaseValue.epoch) !== Number(fence.leaseEpoch) ||
        Number(leaseValue.expiresAt) <= now()
      ) throw new Error('Offline storage fence is stale');
      const current = await epochs(stores.control, fence.scope, fence.bookId, true);
      if (
        current.scopeEpoch !== Number(fence.scopeEpoch) ||
        current.titleEpoch !== Number(fence.titleEpoch)
      ) throw new Error('Offline storage fence is stale');
      if (!allowTombstone && await requestResult(stores.control.get(tombstoneKey(scope, bookId)))) {
        throw new Error('Offline title was deleted');
      }
      return current;
    }

    async function chaptersForArtifact(chapters, scope, artifactId) {
      return cursorValues(chapters.index('scopeArtifact'), keyRange().only(artifactKey(scope, artifactId)));
    }

    async function ownedChapters(chapters, scope, artifactId, bookId) {
      const rows = await chaptersForArtifact(chapters, scope, artifactId);
      return rows.filter(row => row.value.bookId === String(bookId));
    }

    async function removeArtifactIfUnreferenced(stores, scope, artifactId) {
      const refs = await cursorValues(
        stores.artifactRefs.index('scopeArtifact'),
        keyRange().only(artifactKey(scope, artifactId))
      );
      if (refs.length) return false;
      const blockKeys = await cursorKeys(
        stores.blocks.index('scopeArtifact'),
        keyRange().only(artifactKey(scope, artifactId))
      );
      for (const row of blockKeys) await requestResult(stores.blocks.delete(row.key));
      const chapterRows = await cursorValues(
        stores.chapters.index('scopeArtifact'),
        keyRange().only(artifactKey(scope, artifactId))
      );
      for (const row of chapterRows) await requestResult(stores.chapters.delete(row.key));
      return true;
    }

    const store = {
      open,

      async listTitles(scope) {
        return transaction(['titles', 'control'], 'readonly', async stores => {
          const active = await cursorValues(stores.control, keyRange().bound(`active${SEP}${scopeKey(scope, '')}`, `active${SEP}${scopeKey(scope, '\uffff')}`));
          const result = {};
          for (const { value: pointer } of active) {
            const title = await requestResult(stores.titles.get(pointer.value.titleKey));
            if (title && !title.tombstone) result[title.bookId] = clone(title.entry);
          }
          return result;
        });
      },

      async importLegacy(scope, manifest) {
        const entries = manifest && typeof manifest === 'object' ? Object.entries(manifest) : [];
        return transaction(['titles', 'control'], 'readwrite', async stores => {
          for (const [fallbackBookId, snapshot] of entries) {
            if (!snapshot || typeof snapshot !== 'object') continue;
            const bookId = String(snapshot.bookId || fallbackBookId || '');
            if (!bookId) continue;
            const revision = String(snapshot.revision || `legacy-v${snapshot.manifestVersion || 0}`);
            const key = titleKey(scope, bookId, revision);
            const active = await requestResult(stores.control.get(activeKey(scope, bookId)));
            const tombstone = await requestResult(stores.control.get(tombstoneKey(scope, bookId)));
            if (active || tombstone) continue;
            await requestResult(stores.titles.put({
              key, scope: String(scope), bookId, revision, legacy: true,
              entry: clone(snapshot), tombstone: false
            }));
            await requestResult(stores.control.put({ key: activeKey(scope, bookId), value: { titleKey: key } }));
            await epochs(stores.control, scope, bookId, true);
          }
        });
      },

      async saveTitle(scope, entry, fence) {
        const bookId = String(entry?.bookId || entry?.id || '');
        const revision = String(entry?.revision || 'legacy');
        if (!bookId) throw new Error('Offline title requires a bookId');
        return transaction(['titles', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, bookId);
          const key = titleKey(scope, bookId, revision);
          await requestResult(stores.titles.put({
            key, scope: String(scope), bookId, revision, legacy: Boolean(entry?.legacy),
            entry: clone({ ...entry, bookId, revision }), tombstone: false
          }));
          const pointerKey = activeKey(scope, bookId);
          const pointer = await requestResult(stores.control.get(pointerKey));
          const active = pointer ? await requestResult(stores.titles.get(pointer.value.titleKey)) : null;
          const protectsReadyRevision = active?.entry?.mode === 'full' && active.entry.state === 'ready';
          const incomingIsComplete = entry?.state === 'ready' ||
            (entry?.state === 'partial' && entry?.autoResume === false);
          if (!pointer || pointer.value.titleKey === key || (!protectsReadyRevision && !incomingIsComplete)) {
            await requestResult(stores.control.put({ key: pointerKey, value: { titleKey: key } }));
          }
        });
      },

      async reviveTitle(scope, bookId, fence) {
        const id = String(bookId || '');
        if (!id) throw new Error('Offline title requires a bookId');
        return transaction(['control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, id, { allowTombstone: true });
          await requestResult(stores.control.delete(tombstoneKey(scope, id)));
        });
      },

      async getChapter(scope, artifactId) {
        if (!validArtifactId(artifactId)) return null;
        return transaction(['chapters'], 'readonly', async stores => {
          const rows = await chaptersForArtifact(stores.chapters, scope, artifactId);
          const ready = rows.find(row => row.value.state === 'ready' && !row.value.legacy);
          return ready ? clone(ready.value) : null;
        });
      },

      async putChapter(scope, bookId, revision, descriptor, fence, ownerKind = 'full') {
        const artifactId = String(descriptor?.artifactId || '');
        const index = Number(descriptor?.index);
        const size = Number(descriptor?.size);
        const hashes = descriptor?.blockHashes;
        if (!['full', 'rolling'].includes(String(ownerKind)) ||
            !validArtifactId(artifactId) || descriptor?.contentHash !== artifactId ||
            descriptor?.etag !== `"${artifactId}"` || !Number.isInteger(index) || index < 0 ||
            !Number.isInteger(size) || size <= 0 || descriptor?.blockSize !== BLOCK_SIZE ||
            !Array.isArray(hashes) || hashes.length !== Math.ceil(size / BLOCK_SIZE) ||
            !hashes.every(validArtifactId)) {
          throw new Error('Invalid offline chapter descriptor');
        }
        const normalizedBookId = String(bookId);
        const normalizedRevision = String(revision);
        return transaction(['chapters', 'artifactRefs', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, normalizedBookId);
          const key = chapterKey(scope, normalizedBookId, normalizedRevision, index);
          const previous = await requestResult(stores.chapters.get(key));
          const existingRefs = await cursorValues(
            stores.artifactRefs.index('scopeArtifact'),
            keyRange().only(artifactKey(scope, artifactId))
          );
          const previousOwnerKinds = previous?.artifactId === artifactId
            ? (Array.isArray(previous.ownerKinds) ? previous.ownerKinds : [previous.ownerKind || 'full'])
            : [];
          const referencedOwnerKinds = existingRefs
            .filter(row => row.value.ownerId === normalizedBookId)
            .map(row => row.value.ownerKind);
          const ownerKinds = [...new Set([...previousOwnerKinds, ...referencedOwnerKinds, String(ownerKind)])];
          const record = {
            ...clone(descriptor), key,
            scope: String(scope), bookId: normalizedBookId, revision: normalizedRevision, index,
            artifactId, scopeArtifact: artifactKey(scope, artifactId), scopeBook: scopeKey(scope, normalizedBookId),
            state: previous?.artifactId === artifactId && previous.state === 'ready' ? 'ready' : 'pending',
            serverState: String(descriptor.state || ''), ownerKind: String(ownerKind), ownerKinds, legacy: false
          };
          await requestResult(stores.chapters.put(record));
          const ownerId = normalizedBookId;
          await requestResult(stores.artifactRefs.put({
            key: refKey(scope, artifactId, ownerKind, ownerId), scope: String(scope), artifactId,
            scopeArtifact: artifactKey(scope, artifactId), ownerKind: String(ownerKind), ownerId,
            scopeOwner: scopeKey(scope, ownerId)
          }));
        });
      },

      async getBlock(scope, artifactId, index) {
        return transaction(['blocks'], 'readonly', async stores => {
          const row = await requestResult(stores.blocks.get(blockKey(scope, artifactId, index)));
          if (!row) return null;
          return { bytes: row.bytes.slice(0), state: row.state, writeId: row.writeId };
        });
      },

      async putPendingBlock(scope, artifactId, index, bytes, fence) {
        if (!validArtifactId(artifactId) || !Number.isInteger(Number(index)) || Number(index) < 0) {
          throw new Error('Invalid offline block');
        }
        const data = bytes instanceof ArrayBuffer
          ? bytes.slice(0)
          : ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
        if (!data) throw new Error('Offline block bytes must be an ArrayBuffer');
        const writeId = `${instanceId}:${++writeSequence}:${String(fence?.ownerId || '')}:${Number(fence?.leaseEpoch) || 0}`;
        return transaction(['blocks', 'chapters', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, fence.bookId);
          const owned = await ownedChapters(stores.chapters, scope, artifactId, fence.bookId);
          if (!owned.length) throw new Error('Offline artifact is not owned by fence title');
          const blockIndex = Number(index);
          const chapter = owned[0].value;
          const expectedSize = Math.min(BLOCK_SIZE, chapter.size - (blockIndex * BLOCK_SIZE));
          if (blockIndex >= chapter.blockHashes.length || data.byteLength !== expectedSize) {
            throw new Error('Offline block size does not match its descriptor');
          }
          await requestResult(stores.blocks.put({
            key: blockKey(scope, artifactId, index), scope: String(scope), artifactId,
            scopeArtifact: artifactKey(scope, artifactId), index: blockIndex,
            bytes: data, size: data.byteLength, state: 'pending', writeId
          }));
          const all = await chaptersForArtifact(stores.chapters, scope, artifactId);
          for (const row of all) {
            if (row.value.state === 'pending') continue;
            row.value.state = 'pending';
            await requestResult(stores.chapters.put(row.value));
          }
          return writeId;
        });
      },

      async markBlockVerified(scope, artifactId, index, writeId, fence) {
        return transaction(['blocks', 'chapters', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, fence.bookId);
          const owned = await ownedChapters(stores.chapters, scope, artifactId, fence.bookId);
          if (!owned.length) throw new Error('Offline artifact is not owned by fence title');
          const key = blockKey(scope, artifactId, index);
          const row = await requestResult(stores.blocks.get(key));
          if (!row || !writeId || row.writeId !== writeId) return false;
          if (row.state === 'verified') return true;
          if (row.state !== 'pending') throw new Error('Offline block is not pending');
          row.state = 'verified';
          await requestResult(stores.blocks.put(row));
          return true;
        });
      },

      async deleteBlock(scope, artifactId, index, fence, writeId) {
        return transaction(['blocks', 'chapters', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, fence.bookId);
          const owned = await ownedChapters(stores.chapters, scope, artifactId, fence.bookId);
          if (!owned.length) throw new Error('Offline artifact is not owned by fence title');
          if (writeId) {
            const current = await requestResult(stores.blocks.get(blockKey(scope, artifactId, index)));
            if (!current || current.writeId !== writeId) return false;
          }
          await requestResult(stores.blocks.delete(blockKey(scope, artifactId, index)));
          const all = await chaptersForArtifact(stores.chapters, scope, artifactId);
          for (const row of all) {
            if (row.value.state === 'pending') continue;
            row.value.state = 'pending';
            await requestResult(stores.chapters.put(row.value));
          }
          return true;
        });
      },

      async listBlocks(scope, artifactId) {
        return transaction(['blocks'], 'readonly', async stores => {
          const rows = await cursorKeys(stores.blocks.index('scopeArtifactMeta'), metadataRange(scope, artifactId));
          return rows.map(({ indexKey }) => ({ index: indexKey[1], state: indexKey[2], size: indexKey[3] }))
            .sort((a, b) => a.index - b.index);
        });
      },

      async markChapterReady(scope, artifactId, fence) {
        return transaction(['chapters', 'blocks', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, fence.bookId);
          const owned = await ownedChapters(stores.chapters, scope, artifactId, fence.bookId);
          if (!owned.length) throw new Error('Offline artifact is not owned by fence title');
          const descriptor = owned[0].value;
          const metadata = await cursorKeys(
            stores.blocks.index('scopeArtifactMeta'),
            metadataRange(scope, artifactId)
          );
          const byIndex = new Map(metadata.map(({ indexKey }) => [indexKey[1], {
            state: indexKey[2], size: indexKey[3]
          }]));
          for (let index = 0; index < descriptor.blockHashes.length; index++) {
            const block = byIndex.get(index);
            const expectedSize = Math.min(BLOCK_SIZE, descriptor.size - (index * BLOCK_SIZE));
            if (!block || block.state !== 'verified' || block.size !== expectedSize) {
              throw new Error('Offline chapter has unverified blocks');
            }
          }
          for (const row of owned) {
            row.value.state = 'ready';
            await requestResult(stores.chapters.put(row.value));
          }
        });
      },

      async acquireLease(ownerId) {
        const owner = String(ownerId || '');
        if (!owner) throw new Error('Offline lease requires an ownerId');
        return transaction(['control'], 'readwrite', async stores => {
          const existing = (await requestResult(stores.control.get('lease')))?.value;
          const time = now();
          if (existing && existing.ownerId !== owner && Number(existing.expiresAt) > time) return null;
          if (existing && existing.ownerId === owner && Number(existing.expiresAt) > time) {
            existing.expiresAt = time + LEASE_MS;
            await requestResult(stores.control.put({ key: 'lease', value: existing }));
            return clone(existing);
          }
          const epochRecord = await requestResult(stores.control.get('lease-epoch'));
          const epoch = (Number(epochRecord?.value) || 0) + 1;
          const token = { ownerId: owner, epoch, expiresAt: time + LEASE_MS };
          await requestResult(stores.control.put({ key: 'lease-epoch', value: epoch }));
          await requestResult(stores.control.put({ key: 'lease', value: token }));
          return clone(token);
        });
      },

      async renewLease(token) {
        return transaction(['control'], 'readwrite', async stores => {
          const existing = (await requestResult(stores.control.get('lease')))?.value;
          if (
            !token || !existing || existing.ownerId !== token.ownerId ||
            Number(existing.epoch) !== Number(token.epoch) || Number(existing.expiresAt) <= now()
          ) return false;
          existing.expiresAt = now() + LEASE_MS;
          await requestResult(stores.control.put({ key: 'lease', value: existing }));
          token.expiresAt = existing.expiresAt;
          return true;
        });
      },

      async releaseLease(token) {
        if (!token) return;
        return transaction(['control'], 'readwrite', async stores => {
          const existing = (await requestResult(stores.control.get('lease')))?.value;
          if (existing && existing.ownerId === token.ownerId && Number(existing.epoch) === Number(token.epoch)) {
            await requestResult(stores.control.delete('lease'));
          }
        });
      },

      async captureFence(token, scope, bookId) {
        return transaction(['control'], 'readwrite', async stores => {
          const lease = (await requestResult(stores.control.get('lease')))?.value;
          if (
            !token || !lease || lease.ownerId !== token.ownerId || Number(lease.epoch) !== Number(token.epoch) ||
            Number(lease.expiresAt) <= now()
          ) throw new Error('Offline lease is not current');
          const current = await epochs(stores.control, scope, bookId, true);
          return { ownerId: token.ownerId, leaseEpoch: lease.epoch, scope: String(scope), bookId: String(bookId), ...current };
        });
      },

      async finalizeTitle(scope, bookId, revision, fence) {
        const id = String(bookId || '');
        const targetRevision = String(revision || '');
        if (!id || !targetRevision) throw new Error('Offline title finalization requires a bookId and revision');
        return transaction(['titles', 'chapters', 'blocks', 'artifactRefs', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, id);
          const targetKey = titleKey(scope, id, targetRevision);
          const target = await requestResult(stores.titles.get(targetKey));
          if (!target || target.tombstone) throw new Error('Offline title revision is not staged');
          const targetIsComplete = target.entry?.state === 'ready' ||
            (target.entry?.state === 'partial' && target.entry?.autoResume === false);
          if (!targetIsComplete) throw new Error('Offline title revision is not complete');

          const chapterRows = await cursorValues(
            stores.chapters.index('scopeBook'),
            keyRange().only(scopeKey(scope, id))
          );
          const targetChapters = chapterRows.filter(row => row.value.revision === targetRevision);
          const readyArtifacts = new Set(
            targetChapters.filter(row => row.value.state === 'ready').map(row => row.value.artifactId)
          );
          const expectedArtifacts = (target.entry?.chapterEntries || [])
            .filter(Boolean)
            .map(entry => entry.artifactId)
            .filter(Boolean);
          if (targetChapters.some(row => row.value.state !== 'ready') ||
              expectedArtifacts.some(artifactId => !readyArtifacts.has(artifactId))) {
            throw new Error('Offline title revision has incomplete chapters');
          }
          const retainedRefs = new Set(
            targetChapters
              .flatMap(row => {
                const kinds = Array.isArray(row.value.ownerKinds)
                  ? row.value.ownerKinds
                  : [row.value.ownerKind || 'full'];
                return kinds.map(kind => `${row.value.artifactId}${SEP}${kind}`);
              })
          );
          const affectedArtifacts = new Set();

          await requestResult(stores.control.put({
            key: activeKey(scope, id),
            value: { titleKey: targetKey }
          }));

          const titleRows = await cursorValues(stores.titles);
          for (const row of titleRows) {
            if (row.value.scope === String(scope) && row.value.bookId === id && row.key !== targetKey) {
              await requestResult(stores.titles.delete(row.key));
            }
          }
          for (const row of chapterRows) {
            if (row.value.revision === targetRevision) continue;
            affectedArtifacts.add(row.value.artifactId);
            await requestResult(stores.chapters.delete(row.key));
          }

          const refs = await cursorValues(
            stores.artifactRefs.index('scopeOwner'),
            keyRange().only(scopeKey(scope, id))
          );
          for (const row of refs) {
            if (retainedRefs.has(`${row.value.artifactId}${SEP}${row.value.ownerKind}`)) continue;
            affectedArtifacts.add(row.value.artifactId);
            await requestResult(stores.artifactRefs.delete(row.key));
          }
          for (const artifactId of affectedArtifacts) {
            await removeArtifactIfUnreferenced(stores, scope, artifactId);
          }
          return clone(target.entry);
        });
      },

      async deleteTitle(scope, bookId) {
        const id = String(bookId);
        return transaction(['titles', 'chapters', 'blocks', 'artifactRefs', 'control'], 'readwrite', async stores => {
          const epochKey = titleEpochKey(scope, id);
          const currentEpoch = Number(await controlValue(stores.control, epochKey, 1)) || 1;
          await requestResult(stores.control.put({ key: epochKey, value: currentEpoch + 1 }));
          await requestResult(stores.control.put({
            key: tombstoneKey(scope, id),
            value: { scope: String(scope), bookId: id, deletedAt: now(), titleEpoch: currentEpoch + 1 }
          }));
          const pointer = await requestResult(stores.control.get(activeKey(scope, id)));
          if (pointer) await requestResult(stores.control.delete(activeKey(scope, id)));
          const titleRows = await cursorValues(stores.titles);
          for (const row of titleRows) {
            if (row.value.scope === String(scope) && row.value.bookId === id) {
              row.value.tombstone = true;
              await requestResult(stores.titles.put(row.value));
            }
          }
          const refs = await cursorValues(stores.artifactRefs.index('scopeOwner'), keyRange().only(scopeKey(scope, id)));
          const affected = new Set();
          for (const row of refs) {
            affected.add(row.value.artifactId);
            await requestResult(stores.artifactRefs.delete(row.key));
          }
          const chapters = await cursorValues(
            stores.chapters.index('scopeBook'),
            keyRange().only(scopeKey(scope, id))
          );
          for (const row of chapters) {
            affected.add(row.value.artifactId);
            await requestResult(stores.chapters.delete(row.key));
          }
          for (const artifactId of affected) await removeArtifactIfUnreferenced(stores, scope, artifactId);
        });
      },

      async fenceScopes(fromScope, toScope) {
        return transaction(['control'], 'readwrite', async stores => {
          const bump = async scope => {
            const key = scopeEpochKey(scope);
            const value = Number(await controlValue(stores.control, key, 1)) || 1;
            const next = value + 1;
            await requestResult(stores.control.put({ key, value: next }));
            return next;
          };
          const fromEpoch = await bump(fromScope);
          const toEpoch = String(fromScope) === String(toScope) ? fromEpoch : await bump(toScope);
          return { fromEpoch, toEpoch };
        });
      },

      async pruneRolling(scope, bookId, retainedArtifactIds, fence) {
        const id = String(bookId);
        const retained = new Set((retainedArtifactIds || []).map(String));
        return transaction(['artifactRefs', 'blocks', 'chapters', 'control'], 'readwrite', async stores => {
          await requireFence(stores, fence, scope, id);
          const refs = await cursorValues(stores.artifactRefs.index('scopeOwner'), keyRange().only(scopeKey(scope, id)));
          const affected = new Set();
          for (const row of refs) {
            if (row.value.ownerKind === 'rolling' && !retained.has(row.value.artifactId)) {
              affected.add(row.value.artifactId);
              await requestResult(stores.artifactRefs.delete(row.key));
            }
          }
          for (const artifactId of affected) {
            const remaining = await cursorValues(
              stores.artifactRefs.index('scopeArtifact'),
              keyRange().only(artifactKey(scope, artifactId))
            );
            const remainingOwnerKinds = new Set(
              remaining
                .filter(row => row.value.ownerId === id)
                .map(row => row.value.ownerKind)
            );
            const chapters = await ownedChapters(stores.chapters, scope, artifactId, id);
            if (!remainingOwnerKinds.size) {
              for (const row of chapters) await requestResult(stores.chapters.delete(row.key));
            } else {
              for (const row of chapters) {
                row.value.ownerKinds = [...remainingOwnerKinds];
                row.value.ownerKind = row.value.ownerKinds[row.value.ownerKinds.length - 1];
                await requestResult(stores.chapters.put(row.value));
              }
            }
            await removeArtifactIfUnreferenced(stores, scope, artifactId);
          }
        });
      }
    };
    return store;
  }

  function cacheHeaders(kind, workerVersion, contractVersion, artifactId) {
    const headers = new Headers();
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Xandrio-Offline-Cache', kind);
    headers.set('X-Xandrio-SW', String(workerVersion || ''));
    headers.set('X-Xandrio-Offline-Contract', String(contractVersion));
    if (artifactId) headers.set('X-Xandrio-Artifact-SHA256', artifactId);
    return headers;
  }

  function responseError(status, kind, workerVersion, contractVersion) {
    return new Response(null, { status, headers: cacheHeaders(kind, workerVersion, contractVersion) });
  }

  function parseRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || ''));
    if (!match || (!match[1] && !match[2])) return null;
    let start;
    let end;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    return { start, end: Math.min(end, size - 1) };
  }

  function blockStream(store, scope, artifactId, start, end, blockSize) {
    let offset = start;
    return new ReadableStream({
      async pull(controller) {
        if (offset > end) return controller.close();
        const index = Math.floor(offset / blockSize);
        const block = await store.getBlock(scope, artifactId, index);
        if (!block || block.state !== 'verified') {
          controller.error(new Error('Offline block became unavailable'));
          return;
        }
        const bytes = new Uint8Array(block.bytes);
        const from = offset - (index * blockSize);
        const take = Math.min(bytes.byteLength - from, (end - offset) + 1);
        if (take <= 0) {
          controller.error(new Error('Offline block is malformed'));
          return;
        }
        controller.enqueue(bytes.slice(from, from + take));
        offset += take;
        if (offset > end) controller.close();
      }
    });
  }

  async function createAudioResponse(request, { store, workerVersion, contractVersion = 2 } = {}) {
    let url;
    try { url = new URL(request.url); } catch { return responseError(504, 'miss', workerVersion, contractVersion); }
    const match = /^\/__xandrio_offline__\/audio\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match || !store) return responseError(504, 'miss', workerVersion, contractVersion);
    let scope;
    let artifactId;
    try {
      scope = decodeURIComponent(match[1]);
      artifactId = decodeURIComponent(match[2]);
    } catch {
      return responseError(504, 'miss', workerVersion, contractVersion);
    }
    if (!scope || !validArtifactId(artifactId)) {
      return responseError(504, 'miss', workerVersion, contractVersion);
    }
    let chapter;
    try {
      chapter = await store.getChapter(scope, artifactId);
    } catch {
      return responseError(503, 'indeterminate', workerVersion, contractVersion);
    }
    if (!chapter || chapter.legacy || chapter.artifactId !== artifactId) {
      return responseError(504, 'miss', workerVersion, contractVersion);
    }
    const size = Number(chapter.size);
    const blockSize = Number(chapter.blockSize);
    if (!Number.isInteger(size) || size <= 0 || blockSize !== BLOCK_SIZE) {
      return responseError(503, 'indeterminate', workerVersion, contractVersion);
    }
    const requestHeaders = request.headers || new Headers();
    const rangeHeader = requestHeaders.get('Range');
    const ifRange = requestHeaders.get('If-Range');
    const ignoreRange = Boolean(rangeHeader && ifRange && ifRange !== String(chapter.etag || ''));
    let range = ignoreRange ? null : parseRange(rangeHeader, size);
    if (rangeHeader && !ignoreRange && !range) {
      const headers = cacheHeaders('hit', workerVersion, contractVersion, artifactId);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    const headers = cacheHeaders('hit', workerVersion, contractVersion, artifactId);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Type', chapter.contentType || 'audio/mpeg');
    headers.set('ETag', chapter.etag || artifactId);
    const method = String(request.method || 'GET').toUpperCase();
    if (range) {
      headers.set('Content-Length', String((range.end - range.start) + 1));
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      return new Response(method === 'HEAD' ? null : blockStream(store, scope, artifactId, range.start, range.end, blockSize), {
        status: 206, headers
      });
    }
    headers.set('Content-Length', String(size));
    return new Response(method === 'HEAD' ? null : blockStream(store, scope, artifactId, 0, size - 1, blockSize), {
      status: 200, headers
    });
  }

  const api = { createStore, createAudioResponse };
  global.XandrioOfflineStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
