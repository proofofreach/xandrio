// One server process per DATA_DIR.
//
// Every in-process guard (book mutation locks, the rebuild `rebuilding` set,
// the in-memory tombstones) and every destructive startup step (claim sweeps,
// journal recovery, temp-file sweeps) assumes it is the only process using the
// data directory. Nothing enforced that: a second `node server.js` against the
// same DATA_DIR ran its recovery over a live sibling's files. This lock is the
// first thing startup takes and the last thing shutdown releases.
//
// Restarts are expected: systemd stops the old unit before starting the new
// one, and the local launchd supervisor waits for the old child to exit, but a
// slow drain can still overlap a few seconds, so acquisition waits a bounded
// time for a live owner. An owner whose PID no longer exists is stale and is
// stolen; a live foreign owner is reported with its PID and start time.
const fsDefault = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const LOCK_FILE_NAME = 'server.lock';
const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_POLL_MS = 100;

function instanceLockPath(dataDir) {
  return path.join(path.resolve(dataDir), 'runtime', LOCK_FILE_NAME);
}

// Any answer other than "no such process" means the owner may still be alive
// (EPERM: alive but owned by another user).
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseOwner(raw) {
  try {
    const owner = JSON.parse(raw);
    if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) return owner;
  } catch {}
  return null;
}

function heldError(lockPath, owner, waitedMs) {
  const who = owner
    ? `PID ${owner.pid}${owner.startedAt ? ` (started ${owner.startedAt})` : ''}${owner.hostname ? ` on ${owner.hostname}` : ''}`
    : 'an unreadable owner';
  const error = new Error(
    `Another Xandrio server holds ${lockPath} (${who}) and did not exit within ${Math.round(waitedMs / 1000)}s. ` +
    'Only one server may use a DATA_DIR at a time; stop the other process or point this one at its own DATA_DIR.'
  );
  error.code = 'INSTANCE_LOCK_HELD';
  error.owner = owner;
  return error;
}

async function acquireInstanceLock({
  dataDir,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  fs = fsDefault,
  isProcessAlive = processAlive,
  now = Date.now,
  log = console
} = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const lockPath = instanceLockPath(dataDir);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = {
    pid: process.pid,
    startedAt: new Date(now() - process.uptime() * 1000).toISOString(),
    hostname: os.hostname()
  };
  const payload = `${JSON.stringify(owner)}\n`;
  // Publish owner and lock together (see json-store.js acquireProcessLock): a
  // lock created empty and filled afterwards has a window in which another
  // starter reads no owner and treats a live lock as stale.
  const candidatePath = `${lockPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const startedWaiting = now();
  let announced = false;
  try {
    await fs.writeFile(candidatePath, payload, { flag: 'wx', mode: 0o600 });
    for (;;) {
      try {
        await fs.link(candidatePath, lockPath);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const current = parseOwner(await fs.readFile(lockPath, 'utf8').catch(() => ''));
      // A dead PID, an unreadable owner, or our own PID (reused after a crash,
      // common for PID 1 in containers) cannot be a live sibling.
      if (!current || current.pid === process.pid || !isProcessAlive(current.pid)) {
        log.warn(`Removing stale instance lock ${lockPath}${current ? ` left by PID ${current.pid}` : ''}`);
        await fs.unlink(lockPath).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        continue;
      }
      const waited = now() - startedWaiting;
      if (waited >= waitMs) throw heldError(lockPath, current, waited);
      if (!announced) {
        announced = true;
        log.warn(`Waiting up to ${Math.round(waitMs / 1000)}s for the previous server (PID ${current.pid}) to release ${lockPath}`);
      }
      await sleep(pollMs);
    }
  } finally {
    await fs.unlink(candidatePath).catch(() => {});
  }

  let released = false;
  // Only remove the lock while it is still ours: a stale-lock steal by a
  // successor that started during our shutdown must not be undone.
  async function release() {
    if (released) return;
    released = true;
    const current = parseOwner(await fs.readFile(lockPath, 'utf8').catch(() => ''));
    if (current && current.pid !== process.pid) return;
    await fs.unlink(lockPath).catch(() => {});
  }
  function releaseSync() {
    if (released) return;
    released = true;
    try {
      const current = parseOwner(fsSync.readFileSync(lockPath, 'utf8'));
      if (current && current.pid !== process.pid) return;
      fsSync.unlinkSync(lockPath);
    } catch {}
  }
  return { path: lockPath, owner, release, releaseSync };
}

module.exports = { LOCK_FILE_NAME, acquireInstanceLock, instanceLockPath, processAlive };
