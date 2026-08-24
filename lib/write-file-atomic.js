// Atomic file publication: exclusive-create temp file in the destination
// directory, fsync, then rename. Readers never observe a partial file, and an
// interrupted write leaves the previous content intact.
const fs = require('fs').promises;
const crypto = require('crypto');

let counter = 0;

async function writeFileAtomic(filePath, data) {
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
    await fs.rename(tmpPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    if (handle !== null) await fs.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { writeFileAtomic };
