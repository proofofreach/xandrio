// On-disk data format version for DATA_DIR.
//
// Stores either match a version exactly or silently overwrite what they find,
// so a rollback to an older release after a newer one has written newer-shaped
// data reads it as corrupt or, worse, as valid-but-different. This file is
// the one place both the server and the deploy script can read to tell. The
// server writes it on first start, refuses to start when the directory is
// newer than the code, and raises it in place when the code is newer (a
// release that changes a store's shape bumps DATA_FORMAT_VERSION alongside).
// scripts/deploy-prod.sh compares it with the previous release before an
// automatic rollback.
const fsDefault = require('node:fs/promises');
const path = require('node:path');

const DATA_FORMAT_VERSION = 1;
const FORMAT_VERSION_FILE = 'format-version';
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']);

function formatVersionPath(dataDir) {
  return path.join(path.resolve(dataDir), FORMAT_VERSION_FILE);
}

async function syncDirectory(fs, dirPath) {
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

async function writeDurable(fs, filePath, text, flag) {
  const handle = await fs.open(filePath, flag, 0o644);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseFormatVersion(raw) {
  const match = /^\s*(\d{1,9})\s*$/.exec(String(raw));
  return match ? Number(match[1]) : null;
}

async function ensureDataFormatVersion({ dataDir, supported = DATA_FORMAT_VERSION, fs = fsDefault } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const filePath = formatVersionPath(dataDir);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Exclusive create: two starters racing here (which the instance lock
    // already prevents) must not both believe they initialized the directory.
    await writeDurable(fs, filePath, `${supported}\n`, 'wx');
    await syncDirectory(fs, path.dirname(filePath));
    return { version: supported, created: true };
  }
  const version = parseFormatVersion(raw);
  if (version === null) {
    const error = new Error(`${filePath} does not contain a data format version (found ${JSON.stringify(raw.trim().slice(0, 40))}); refusing to guess`);
    error.code = 'DATA_FORMAT_VERSION_INVALID';
    throw error;
  }
  if (version > supported) {
    const error = new Error(
      `Data directory ${path.dirname(filePath)} is format version ${version}, but this release supports up to ${supported}. ` +
      'A newer release has written here; deploy that release (or newer) instead of rolling back, or restore the data backup taken before it ran.'
    );
    error.code = 'DATA_FORMAT_VERSION_TOO_NEW';
    error.version = version;
    error.supported = supported;
    throw error;
  }
  if (version < supported) {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeDurable(fs, tmpPath, `${supported}\n`, 'w');
    await fs.rename(tmpPath, filePath);
    await syncDirectory(fs, path.dirname(filePath));
    return { version: supported, upgradedFrom: version };
  }
  return { version };
}

module.exports = { DATA_FORMAT_VERSION, FORMAT_VERSION_FILE, ensureDataFormatVersion, formatVersionPath, parseFormatVersion };
