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

async function load(filePath, defaultValue = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
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
