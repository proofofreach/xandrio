// Redacted, read-only operational diagnostics.
//
// Keep the response schema explicit. Filesystem errors and engine payloads can
// contain paths, provider details, custom voice names, or other user data, so
// none of those values are copied into the public result.

const crypto = require('crypto');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');

const LOW_CACHE_BYTES = 1024 * 1024 * 1024;
const LOW_CACHE_RATIO = 0.1;
const ENGINE_NAMES = Object.freeze(['edge', 'kokoro', 'chatterbox']);

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(Math.round(number), Number.MAX_SAFE_INTEGER);
}

async function probeDirectory(directory, {
  access = fs.access,
  open = fs.open,
  unlink = fs.unlink,
  randomBytes = crypto.randomBytes
} = {}) {
  let readable = false;
  let writable = false;
  let probePath = null;
  let handle = null;

  try {
    await access(directory, fsConstants.R_OK);
    readable = true;
  } catch {}

  try {
    const suffix = randomBytes(8).toString('hex');
    probePath = path.join(directory, `.xandrio-diagnostics-${process.pid}-${suffix}.tmp`);
    handle = await open(probePath, 'wx', 0o600);
    await handle.close();
    handle = null;
    await unlink(probePath);
    probePath = null;
    writable = true;
  } catch {
    await handle?.close().catch(() => {});
    if (probePath) await unlink(probePath).catch(() => {});
  }

  return {
    status: readable && writable ? 'ok' : 'error',
    readable,
    writable
  };
}

async function countQuarantines(directory, readdir = fs.readdir) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => (
      entry.isFile() &&
      /^[A-Za-z0-9._-]+\.corrupt-[a-f0-9]{8}$/i.test(entry.name)
    )).length;
  } catch {
    return null;
  }
}

async function cacheSpace(directory, statfs = fs.statfs) {
  try {
    if (typeof statfs !== 'function') return { status: 'unavailable', freeBytes: null, totalBytes: null };
    const stat = await statfs(directory);
    const blockSize = Number(stat.bsize);
    const freeBytes = safeBytes(Number(stat.bavail) * blockSize);
    const totalBytes = safeBytes(Number(stat.blocks) * blockSize);
    if (freeBytes === null || totalBytes === null || totalBytes === 0) {
      return { status: 'unavailable', freeBytes: null, totalBytes: null };
    }
    const low = freeBytes < LOW_CACHE_BYTES || freeBytes / totalBytes < LOW_CACHE_RATIO;
    return { status: low ? 'warning' : 'ok', freeBytes, totalBytes };
  } catch {
    return { status: 'unavailable', freeBytes: null, totalBytes: null };
  }
}

function redactedQueue(value) {
  return {
    active: safeCount(value?.active),
    queued: safeCount(value?.queued),
    completed: safeCount(value?.completed)
  };
}

function redactedEngines(value) {
  const source = value?.engines || {};
  return Object.fromEntries(ENGINE_NAMES.map(name => {
    const engine = source[name];
    const up = engine?.up === true;
    const status = up
      ? 'online'
      : engine?.status === 'starting'
        ? 'starting'
        : 'offline';
    return [name, {
      available: up,
      status,
      managedProcess: engine?.process === true
    }];
  }));
}

function storageIssue(label, result) {
  if (result.readable && result.writable) return null;
  return {
    code: `${label.toUpperCase()}_STORAGE_UNAVAILABLE`,
    severity: 'error',
    message: `${label === 'data' ? 'Application data' : 'Audio cache'} storage is not readable and writable.`,
    action: 'Check the mounted volume, filesystem permissions, and available disk space, then restart the service and refresh diagnostics.'
  };
}

function engineIssues(engines) {
  return Object.entries(engines)
    .filter(([, engine]) => !engine.available)
    .map(([name, engine]) => ({
      code: `ENGINE_${name.toUpperCase()}_${engine.status.toUpperCase()}`,
      severity: 'warning',
      message: `${name === 'edge' ? 'Edge' : name[0].toUpperCase() + name.slice(1)} narration is ${engine.status}.`,
      action: 'Confirm the selected voice provider is enabled, then use Refresh diagnostics. If it remains unavailable, restart the service and inspect its logs.'
    }));
}

function createOperatorDiagnostics({
  dataDir,
  cacheDir,
  getQueueStatus,
  getEngineStatus,
  uptime = () => process.uptime(),
  now = () => new Date(),
  filesystem = {}
}) {
  if (!dataDir || !cacheDir) throw new TypeError('dataDir and cacheDir are required');
  if (typeof getQueueStatus !== 'function') throw new TypeError('getQueueStatus is required');
  if (typeof getEngineStatus !== 'function') throw new TypeError('getEngineStatus is required');

  return async function collectDiagnostics({ refreshEngines = false } = {}) {
    const [dataStorage, cacheStorage, quarantineCount, space, rawEngines] = await Promise.all([
      probeDirectory(dataDir, filesystem),
      probeDirectory(cacheDir, filesystem),
      countQuarantines(dataDir, filesystem.readdir),
      cacheSpace(cacheDir, filesystem.statfs),
      Promise.resolve()
        .then(() => getEngineStatus({ refresh: refreshEngines }))
        .catch(() => ({ engines: {} }))
    ]);

    let rawQueue = {};
    try {
      rawQueue = getQueueStatus() || {};
    } catch {}

    const engines = redactedEngines(rawEngines);
    const issues = [
      storageIssue('data', dataStorage),
      storageIssue('cache', cacheStorage)
    ].filter(Boolean);

    if (quarantineCount === null) {
      issues.push({
        code: 'QUARANTINE_SCAN_UNAVAILABLE',
        severity: 'warning',
        message: 'The server could not check for quarantined JSON stores.',
        action: 'Check data-volume readability, then refresh diagnostics.'
      });
    } else if (quarantineCount > 0) {
      issues.push({
        code: 'QUARANTINED_JSON_STORES',
        severity: 'error',
        message: `${quarantineCount} quarantined JSON store ${quarantineCount === 1 ? 'copy needs' : 'copies need'} review.`,
        action: 'Stop the application and follow docs/JSON_STORE_RECOVERY.md before restoring any store.',
        documentation: 'docs/JSON_STORE_RECOVERY.md'
      });
    }

    if (space.status === 'warning') {
      issues.push({
        code: 'CACHE_SPACE_LOW',
        severity: 'warning',
        message: 'Audio cache disk space is low.',
        action: 'Free space on the cache volume or expand it before generating more narration.'
      });
    } else if (space.status === 'unavailable') {
      issues.push({
        code: 'CACHE_SPACE_UNKNOWN',
        severity: 'warning',
        message: 'The server could not determine available cache disk space.',
        action: 'Check the cache volume with host storage tools and refresh diagnostics.'
      });
    }

    issues.push(...engineIssues(engines));

    return {
      status: issues.some(issue => issue.severity === 'error')
        ? 'error'
        : issues.length
          ? 'warning'
          : 'ok',
      generatedAt: now().toISOString(),
      uptimeSeconds: Math.max(0, Math.round(Number(uptime()) || 0)),
      storage: {
        data: dataStorage,
        cache: {
          ...cacheStorage,
          space
        }
      },
      quarantinedStoreCount: quarantineCount,
      queue: redactedQueue(rawQueue),
      engines,
      issues
    };
  };
}

module.exports = {
  LOW_CACHE_BYTES,
  LOW_CACHE_RATIO,
  createOperatorDiagnostics,
  __test: {
    cacheSpace,
    countQuarantines,
    probeDirectory,
    redactedEngines,
    redactedQueue
  }
};
