const fs = require('node:fs/promises');
const path = require('node:path');

const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

// Per-writer temporaries carry their writer's PID. A writer unlinks its own
// temp on success or failure, but a crash or a shutdown deadline leaves it.
// Each pattern captures the owner PID.
const ABANDONED_PART_PATTERNS = [
  // lib/tts-queue.js uniquePartPath: <out>.<pid>.<hex>.<n>.part[.<ext>]
  /^.+\.([1-9]\d*)\.[a-f0-9]{8}\.\d+\.part(?:\.(?:mp3|wav|m4a))?$/,
  // lib/chunked-tts.js single-chunk copy and concat output:
  // <chapter>.<pid>.<hex>.part.<ext>
  /^.+_ch\d+\.(?:mp3|wav|m4a)\.([1-9]\d*)\.[a-f0-9]{8}\.part\.(?:mp3|wav|m4a)$/,
  // lib/chunked-tts.js per-run concat list: <list>.<pid>.<hex>.tmp
  /^.+_ch\d+_concat(?:_clean)?\.txt\.([1-9]\d*)\.[a-f0-9]{8}\.tmp$/,
  // lib/remote-download.js import download: .<file>.<pid>.<16hex>.part
  /^\..+\.([1-9]\d*)\.[a-f0-9]{16}\.part$/,
  // lib/write-file-atomic.js extracted artifact: <id>.xbook.json.<pid>.<hex>.<n>.tmp
  /^.+\.xbook\.json\.([1-9]\d*)\.[a-f0-9]{8}\.\d+\.tmp$/
];

// True only when the recorded owner cannot still be writing entryPath: the
// PID no longer exists, or it is this process's own PID reused from an earlier
// process (containers commonly reuse PID 1) and the entry predates this
// process. Any other answer, including EPERM, means "maybe alive".
async function ownerProcessGone(pid, entryPath) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  if (pid === process.pid) {
    return fs.stat(entryPath).then(stat => stat.mtimeMs < PROCESS_STARTED_AT, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// Startup sweep of per-writer TTS and concat temporaries in the cache root.
// Never touches a live owner's files, directories, symlinks, or other names.
async function removeAbandonedPartFiles(cacheDir) {
  const root = await fs.realpath(cacheDir).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!root) return 0;
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.includes('_offline_')) continue; // swept by offline-audio-package
    const match = ABANDONED_PART_PATTERNS.map(pattern => entry.name.match(pattern)).find(Boolean);
    if (!match) continue;
    const entryPath = path.join(root, entry.name);
    if (!(await ownerProcessGone(Number(match[1]), entryPath))) continue;
    await fs.unlink(entryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    removed++;
  }
  return removed;
}

module.exports = { ABANDONED_PART_PATTERNS, PROCESS_STARTED_AT, ownerProcessGone, removeAbandonedPartFiles };
