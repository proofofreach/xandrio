// Atomic, serialized JSON file persistence.
//
// The basic load/save/update API remains suitable for reconstructable state.
// Critical stores must opt in through createCriticalStore(), which adds strict
// validation, bounded backups, and recovery operations.

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const SKIP_SAVE = Symbol('json-store-skip-save');
const locks = new Map();
const heldProcessLocks = new Map();
let tmpCounter = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processLockPath(filePath) {
  return `${path.resolve(filePath)}.lock`;
}

async function stealStaleProcessLock(lockPath) {
  let pidText;
  try {
    pidText = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const pid = Number.parseInt(String(pidText).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    await fs.unlink(lockPath).catch(() => {});
    return;
  }
  if (pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') await fs.unlink(lockPath).catch(() => {});
  }
}

async function acquireProcessLock(filePath) {
  const key = path.resolve(filePath);
  const existing = heldProcessLocks.get(key);
  if (existing) {
    existing.depth += 1;
    return existing;
  }
  const lockPath = processLockPath(key);
  for (;;) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } catch (error) {
        await handle.close().catch(() => {});
        handle = null;
        await fs.unlink(lockPath).catch(() => {});
        throw error;
      }
      const acquired = { key, lockPath, handle, depth: 1 };
      heldProcessLocks.set(key, acquired);
      return acquired;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await stealStaleProcessLock(lockPath);
      await sleep(25);
    }
  }
}

async function releaseProcessLock(acquired) {
  acquired.depth -= 1;
  if (acquired.depth > 0) return;
  if (heldProcessLocks.get(acquired.key) === acquired) heldProcessLocks.delete(acquired.key);
  try {
    await fs.unlink(acquired.lockPath).catch(() => {});
  } finally {
    await acquired.handle.close().catch(() => {});
  }
}

function withLock(filePath, fn) {
  const key = path.resolve(filePath);
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.then(async () => {
    const acquired = await acquireProcessLock(key);
    try {
      return await fn();
    } finally {
      await releaseProcessLock(acquired);
    }
  });
  // Keep a non-rejecting tail so one failure cannot poison later operations.
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  // Compare identity before deleting: a newer operation may already have
  // replaced this tail while the older one was settling.
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

function pendingLockCount() {
  return locks.size;
}

function validationFailure(filePath, detail, cause) {
  const suffix = detail ? `: ${detail}` : '';
  const error = new Error(`json-store: validation failed for ${filePath}${suffix}`, cause ? { cause } : undefined);
  error.code = 'JSON_STORE_VALIDATION_FAILED';
  return error;
}

function validateData(data, validate, filePath) {
  if (validate == null) return data;
  if (typeof validate !== 'function') throw new TypeError('validate must be a function');
  let result;
  try {
    result = validate(data);
  } catch (error) {
    throw validationFailure(filePath, error.message, error);
  }
  if (result && typeof result.then === 'function') {
    throw validationFailure(filePath, 'validator must be synchronous');
  }
  if (result === false) throw validationFailure(filePath, 'validator returned false');
  if (typeof result === 'string' && result) throw validationFailure(filePath, result);
  return data;
}

function parseAndValidate(raw, filePath, validate) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`json-store: ${filePath} is not valid JSON`, { cause });
    error.code = 'JSON_STORE_CORRUPT';
    throw error;
  }
  return validateData(data, validate, filePath);
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'
]);

async function syncDirectory(dirPath) {
  let handle;
  try {
    handle = await fs.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusiveDurable(filePath, raw) {
  let handle;
  let created = false;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    created = true;
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fs.unlink(filePath).catch(() => {});
    throw error;
  }
}

// Preserve invalid bytes before callers can fall back to defaults. The content
// hash deduplicates repeated loads of the same damaged file.
async function quarantineCorrupt(filePath, raw) {
  const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  const quarantinePath = `${filePath}.corrupt-${digest}`;
  try {
    await writeExclusiveDurable(quarantinePath, raw);
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        if (await fs.readFile(quarantinePath, 'utf8') === raw) {
          console.error(`json-store: ${filePath} is not valid JSON; a copy is already preserved at ${quarantinePath}`);
          return quarantinePath;
        }
      } catch {}
    }
    const failure = new Error(
      `json-store: ${filePath} is not valid JSON and could not be preserved at ${quarantinePath} (${err.code || err.message})`,
      { cause: err }
    );
    failure.code = 'JSON_STORE_QUARANTINE_FAILED';
    console.error(failure.message);
    throw failure;
  }
  console.error(`json-store: ${filePath} is not valid JSON; preserved a copy at ${quarantinePath}`);
  return quarantinePath;
}

// Sibling marker recording that a critical store has completed at least one
// real write. Its presence turns a missing data file from "never set up"
// (safe to default) into "went missing after being initialized" (must fail
// closed) — see markInitialized()/hasMarker() below.
function markerPath(filePath) {
  return `${filePath}.initialized`;
}

async function hasMarker(filePath) {
  try {
    await fs.access(markerPath(filePath));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function markInitialized(filePath) {
  try {
    const handle = await fs.open(markerPath(filePath), 'wx', 0o600);
    await handle.close();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function load(filePath, defaultValue = {}, options = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (options.requireMarker && await hasMarker(filePath)) {
        console.error(`json-store: ${filePath} is missing but this store was previously initialized; refusing to fall back to defaults`);
        const error = new Error(`json-store: ${filePath} is missing after having been initialized`);
        error.code = 'JSON_STORE_MISSING_AFTER_INIT';
        throw error;
      }
      // Clone: defaultValue is caller-owned and may be reused across many
      // load() calls (createCriticalStore closes over one instance). Callers
      // routinely mutate whatever load() returns, so handing back the same
      // object would let one process's in-memory edits leak into every
      // subsequent "file missing" read, including after the file was
      // deliberately deleted.
      return validateData(structuredClone(defaultValue), options.validate, filePath);
    }
    console.error(`json-store: cannot read ${filePath} (${err.code || err.message}); refusing to replace it with defaults`);
    throw err;
  }

  try {
    const data = parseAndValidate(raw, filePath, options.validate);
    // The file exists and parsed cleanly, so this store has real data —
    // backfill the marker for stores written before requireMarker existed,
    // closing the gap on their next successful read rather than waiting for
    // a write. Only relevant when the file was actually present (this
    // branch), never on the ENOENT/defaultValue path above.
    if (options.requireMarker) await markInitialized(filePath).catch(() => {});
    return data;
  } catch (error) {
    if (error.code !== 'JSON_STORE_CORRUPT') throw error;
    await quarantineCorrupt(filePath, raw);
    if (options.throwOnCorrupt) throw error;
    return validateData(structuredClone(defaultValue), options.validate, filePath);
  }
}

async function writeAtomicRaw(filePath, raw) {
  const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmpPath, 'wx', 0o600);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => {});
    // After a successful rename the temporary path no longer exists.
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function writeAtomic(filePath, data, options = {}) {
  validateData(data, options.validate, filePath);
  await writeAtomicRaw(filePath, JSON.stringify(data, null, 2));
}

function save(filePath, data, options = {}) {
  return withLock(filePath, () => writeAtomic(filePath, data, options));
}

function update(filePath, mutator, defaultValue = {}, options = {}) {
  return withLock(filePath, async () => {
    const data = await load(filePath, defaultValue, options);
    const result = await mutator(data);
    if (result !== SKIP_SAVE) await writeAtomic(filePath, data, options);
    return result;
  });
}

function backupDirectory(filePath) {
  return `${filePath}.backups`;
}

function normalizeMaxBackups(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new RangeError('maxBackups must be an integer from 1 to 100');
  }
  return number;
}

const HOURLY_BACKUP_RETENTION_MS = 24 * 60 * 60 * 1000;
const DAILY_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function retainedBackupPaths(backups, maxBackups, nowMs = Date.now()) {
  const retained = new Set(backups.slice(0, maxBackups).map(backup => backup.path));
  const hourlyBuckets = new Set();
  const dailyBuckets = new Set();
  // Oldest first preserves the first pre-write state in each bucket. A burst
  // of valid writes in one hour can rotate the newest-N set indefinitely, but
  // cannot displace that hour's recovery floor.
  for (const backup of [...backups].reverse()) {
    const age = Math.max(0, nowMs - backup.mtimeMs);
    if (age <= HOURLY_BACKUP_RETENTION_MS) {
      const bucket = Math.floor(backup.mtimeMs / (60 * 60 * 1000));
      if (!hourlyBuckets.has(bucket)) {
        hourlyBuckets.add(bucket);
        retained.add(backup.path);
      }
    }
    if (age <= DAILY_BACKUP_RETENTION_MS) {
      const bucket = Math.floor(backup.mtimeMs / (24 * 60 * 60 * 1000));
      if (!dailyBuckets.has(bucket)) {
        dailyBuckets.add(bucket);
        retained.add(backup.path);
      }
    }
  }
  return retained;
}

async function listBackupPaths(filePath) {
  const dir = backupDirectory(filePath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const candidatePath = path.join(dir, entry.name);
    const stat = await fs.stat(candidatePath);
    results.push({ path: candidatePath, mtimeMs: stat.mtimeMs });
  }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
}

async function rotateBackups(filePath, maxBackups) {
  const backups = await listBackupPaths(filePath);
  const retained = retainedBackupPaths(backups, maxBackups);
  const expired = backups.filter(backup => !retained.has(backup.path));
  for (const backup of expired) {
    try {
      await fs.unlink(backup.path);
    } catch (err) {
      // Cleanup is idempotent: a concurrent rotation or external sweep may
      // have removed the file already. Only ENOENT is safe to ignore.
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  if (expired.length > 0) await syncDirectory(backupDirectory(filePath));
}

async function preserveRawBackup(filePath, raw, { maxBackups, reason = 'backup' }) {
  const dir = backupDirectory(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Zero-padded: listBackupPaths breaks mtimeMs ties with a plain string
  // compare, and an un-padded counter would sort "...-10-..." before
  // "...-9-...", ordering a newer same-millisecond backup as older.
  const counter = String(++tmpCounter).padStart(6, '0');
  const name = `${timestamp}-${reason}-${process.pid}-${counter}-${digest}.json`;
  const backupPath = path.join(dir, name);
  await writeExclusiveDurable(backupPath, raw);
  await rotateBackups(filePath, maxBackups);
  return backupPath;
}

// Combines the pre-write backup with a no-op check: reads the current file
// once, and if its bytes already equal what the caller is about to write,
// skips both the backup and the write entirely instead of copying,
// fsyncing, and rotating backups for a change that didn't happen (e.g. a
// mutator whose branch left the store untouched but didn't return
// SKIP_SAVE).
async function preserveCurrentIfChanged(filePath, nextRaw, { validate, maxBackups }) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { changed: true };
    throw error;
  }
  if (raw === nextRaw) return { changed: false };
  parseAndValidate(raw, filePath, validate);
  await preserveRawBackup(filePath, raw, { maxBackups });
  return { changed: true };
}

function isRecoveryPath(filePath, candidatePath) {
  const target = path.resolve(filePath);
  const candidate = path.resolve(candidatePath);
  const backupDir = `${target}.backups${path.sep}`;
  return candidate.startsWith(backupDir) ||
    (path.dirname(candidate) === path.dirname(target) &&
      path.basename(candidate).startsWith(`${path.basename(target)}.corrupt-`));
}

async function listRecoveryCandidates(filePath, { validate } = {}) {
  const target = path.resolve(filePath);
  const parent = path.dirname(target);
  const base = path.basename(target);
  const paths = (await listBackupPaths(target)).map(item => ({ ...item, kind: 'backup' }));
  let entries = [];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`${base}.corrupt-`)) continue;
    const candidatePath = path.join(parent, entry.name);
    const stat = await fs.stat(candidatePath);
    paths.push({ path: candidatePath, mtimeMs: stat.mtimeMs, kind: 'quarantine' });
  }

  const candidates = [];
  for (const item of paths.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))) {
    let raw;
    let valid = false;
    let error = null;
    try {
      raw = await fs.readFile(item.path, 'utf8');
      parseAndValidate(raw, item.path, validate);
      valid = true;
    } catch (failure) {
      error = failure.message;
    }
    candidates.push({
      path: item.path,
      kind: item.kind,
      valid,
      error,
      size: raw == null ? null : Buffer.byteLength(raw),
      mtime: new Date(item.mtimeMs).toISOString()
    });
  }
  return candidates;
}

async function restoreRecoveryCandidate(filePath, candidatePath, { validate, maxBackups = 5 } = {}) {
  const target = path.resolve(filePath);
  const candidate = path.resolve(candidatePath);
  const limit = normalizeMaxBackups(maxBackups);
  if (!isRecoveryPath(target, candidate)) {
    const error = new Error('Recovery candidate must be a backup or quarantine copy for the target store');
    error.code = 'JSON_STORE_UNSAFE_RECOVERY_PATH';
    throw error;
  }

  return withLock(target, async () => {
    const candidateStat = await fs.lstat(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      const error = new Error('Recovery candidate must be a regular file');
      error.code = 'JSON_STORE_UNSAFE_RECOVERY_PATH';
      throw error;
    }
    const raw = await fs.readFile(candidate, 'utf8');
    parseAndValidate(raw, candidate, validate);

    let current;
    try {
      current = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current != null) {
      // Preserve even malformed current bytes. The recovery candidate is
      // validated, while the displaced state remains available for rollback.
      await preserveRawBackup(target, current, { maxBackups: limit, reason: 'pre-restore' });
    }
    await writeAtomicRaw(target, raw);
    return { restoredFrom: candidate, preservedCurrent: current != null };
  });
}

function createCriticalStore({ filePath, defaultValue = {}, validate, maxBackups = 5 }) {
  if (!filePath) throw new TypeError('filePath is required');
  if (typeof validate !== 'function') throw new TypeError('validate is required for a critical store');
  const limit = normalizeMaxBackups(maxBackups);
  // requireMarker makes a missing file fail closed once the store has been
  // initialized at least once, instead of silently degrading to
  // defaultValue as if this were still first-run bootstrap.
  const options = { validate, throwOnCorrupt: true, requireMarker: true };

  return {
    filePath: path.resolve(filePath),
    load() {
      return load(filePath, defaultValue, options);
    },
    save(data) {
      return withLock(filePath, async () => {
        validateData(data, validate, filePath);
        const nextRaw = JSON.stringify(data, null, 2);
        const { changed } = await preserveCurrentIfChanged(filePath, nextRaw, { validate, maxBackups: limit });
        if (changed) await writeAtomicRaw(filePath, nextRaw);
        await markInitialized(filePath);
      });
    },
    update(mutator) {
      return withLock(filePath, async () => {
        const data = await load(filePath, defaultValue, options);
        const result = await mutator(data);
        if (result === SKIP_SAVE) return result;
        validateData(data, validate, filePath);
        const nextRaw = JSON.stringify(data, null, 2);
        const { changed } = await preserveCurrentIfChanged(filePath, nextRaw, { validate, maxBackups: limit });
        if (changed) await writeAtomicRaw(filePath, nextRaw);
        await markInitialized(filePath);
        return result;
      });
    },
    listRecoveryCandidates() {
      return listRecoveryCandidates(filePath, { validate });
    },
    async restore(candidatePath) {
      const result = await restoreRecoveryCandidate(filePath, candidatePath, {
        validate,
        maxBackups: limit
      });
      await markInitialized(filePath);
      return result;
    }
  };
}

module.exports = {
  load,
  save,
  update,
  withLock,
  pendingLockCount,
  createCriticalStore,
  listRecoveryCandidates,
  restoreRecoveryCandidate,
  retainedBackupPaths,
  SKIP_SAVE
};
