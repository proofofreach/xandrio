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
let tmpCounter = 0;

function withLock(filePath, fn) {
  const key = path.resolve(filePath);
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.then(fn);
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

async function load(filePath, defaultValue = {}, options = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return validateData(defaultValue, options.validate, filePath);
    console.error(`json-store: cannot read ${filePath} (${err.code || err.message}); refusing to replace it with defaults`);
    throw err;
  }

  try {
    return parseAndValidate(raw, filePath, options.validate);
  } catch (error) {
    if (error.code !== 'JSON_STORE_CORRUPT') throw error;
    await quarantineCorrupt(filePath, raw);
    if (options.throwOnCorrupt) throw error;
    return validateData(defaultValue, options.validate, filePath);
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
  for (const backup of backups.slice(maxBackups)) {
    await fs.unlink(backup.path);
  }
  if (backups.length > maxBackups) await syncDirectory(backupDirectory(filePath));
}

async function preserveRawBackup(filePath, raw, { maxBackups, reason = 'backup' }) {
  const dir = backupDirectory(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${timestamp}-${reason}-${process.pid}-${++tmpCounter}-${digest}.json`;
  const backupPath = path.join(dir, name);
  await writeExclusiveDurable(backupPath, raw);
  await rotateBackups(filePath, maxBackups);
  return backupPath;
}

async function preserveCurrent(filePath, { validate, maxBackups }) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  parseAndValidate(raw, filePath, validate);
  return preserveRawBackup(filePath, raw, { maxBackups });
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
  const options = { validate, throwOnCorrupt: true };

  return {
    filePath: path.resolve(filePath),
    load() {
      return load(filePath, defaultValue, options);
    },
    save(data) {
      return withLock(filePath, async () => {
        validateData(data, validate, filePath);
        await preserveCurrent(filePath, { validate, maxBackups: limit });
        await writeAtomic(filePath, data, { validate });
      });
    },
    update(mutator) {
      return withLock(filePath, async () => {
        const data = await load(filePath, defaultValue, options);
        const result = await mutator(data);
        if (result === SKIP_SAVE) return result;
        validateData(data, validate, filePath);
        await preserveCurrent(filePath, { validate, maxBackups: limit });
        await writeAtomic(filePath, data, { validate });
        return result;
      });
    },
    listRecoveryCandidates() {
      return listRecoveryCandidates(filePath, { validate });
    },
    restore(candidatePath) {
      return restoreRecoveryCandidate(filePath, candidatePath, {
        validate,
        maxBackups: limit
      });
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
  SKIP_SAVE
};
