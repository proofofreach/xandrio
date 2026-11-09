// Atomic file publication: exclusive-create temp file in the destination
// directory, fsync, then rename. Readers never observe a partial file, and an
// interrupted write leaves the previous content intact.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

let counter = 0;

// Directory fsync is what makes the rename itself durable; without it a power
// loss can roll the directory back to the old entry even though the new
// file's bytes were synced. Some filesystems refuse to fsync a directory
// handle; those codes mean "not supported here", not "the write failed".
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']);

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

async function writeFileAtomic(filePath, data, { beforeRename = null } = {}) {
  const tmpPath = `${filePath}.${process.pid}.${crypto
    .randomBytes(4)
    .toString('hex')}.${++counter}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmpPath, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    if (beforeRename) await beforeRename();
    await fs.rename(tmpPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => {});
    // Always attempt unlink: a failed rename must not leave a durable temp
    // file, and a successful rename makes this ENOENT.
    await fs.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { writeFileAtomic };
