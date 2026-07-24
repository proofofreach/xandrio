// Atomic, serialized JSON file persistence.
//
// Every write goes through a per-file promise-chain mutex and lands via
// write-to-temp-then-rename, so a crash mid-write can never truncate a
// state file and concurrent read-modify-write cycles can never interleave.
//
// update(filePath, mutator) is the primary API for mutations: the mutator
// receives the parsed data, mutates it IN PLACE, and the same object is
// written back under the lock. Return jsonStore.SKIP_SAVE from the mutator
// to abort the write (e.g. record not found); any other return value is
// passed through as update()'s result. Throwing from the mutator also
// skips the write and propagates the error.

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
  // The stored tail must never reject, or every later write would fail too.
  locks.set(key, run.then(() => {}, () => {}));
  return run;
}

// An unparseable state file still resolves to the default so the server can
// boot, but the next update() would then write those defaults straight over
// it — silently destroying a library or every account. Preserve the bytes
// first. The copy is named by content hash so repeatedly loading the same
// corrupt file cannot fill the disk with duplicates.
async function quarantineCorrupt(filePath, raw) {
  const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  const quarantinePath = `${filePath}.corrupt-${digest}`;
  try {
    // Write the bytes load() actually parsed, rather than copying a path that
    // another process could replace between readFile() and this operation.
    await fs.writeFile(quarantinePath, raw, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        if (await fs.readFile(quarantinePath, 'utf8') === raw) {
          console.error(`json-store: ${filePath} is not valid JSON; a copy is already preserved at ${quarantinePath} and defaults will be used`);
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
    // Never return defaults when the original cannot first be preserved:
    // update() would otherwise write those defaults over the only copy.
    throw failure;
  }
  console.error(`json-store: ${filePath} is not valid JSON; preserved a copy at ${quarantinePath} and fell back to defaults`);
  return quarantinePath;
}

async function load(filePath, defaultValue = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    // A missing file is the ordinary first-run path; anything else (EACCES,
    // EISDIR, EIO) is worth surfacing even though we still return defaults.
    if (err.code !== 'ENOENT') {
      console.error(`json-store: cannot read ${filePath} (${err.code || err.message}); falling back to defaults`);
    }
    return defaultValue;
  }

  try {
    return JSON.parse(raw);
  } catch {
    await quarantineCorrupt(filePath, raw);
    return defaultValue;
  }
}

async function writeAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600);
}

function save(filePath, data) {
  return withLock(filePath, () => writeAtomic(filePath, data));
}

function update(filePath, mutator, defaultValue = {}) {
  return withLock(filePath, async () => {
    const data = await load(filePath, defaultValue);
    const result = await mutator(data);
    if (result !== SKIP_SAVE) await writeAtomic(filePath, data);
    return result;
  });
}

module.exports = { load, save, update, withLock, SKIP_SAVE };
