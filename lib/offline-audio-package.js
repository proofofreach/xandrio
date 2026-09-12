const crypto = require('crypto');
const fsNative = require('fs');
const fsp = fsNative.promises;
const path = require('path');
const { spawn: spawnDefault } = require('child_process');
const { pipeline } = require('stream/promises');
const { isSafeBookId } = require('./request-guards');

const OFFLINE_AUDIO_BITRATE_KBPS = 48;
const OFFLINE_AUDIO_PACKAGE_VERSION = 1;
const OFFLINE_AUDIO_SAMPLE_RATE = 24000;
const OFFLINE_AUDIO_CHANNELS = 1;
const OFFLINE_AUDIO_BLOCK_SIZE = 1024 * 1024;
const OFFLINE_INTEGRITY_SCHEMA_VERSION = 1;
const MIN_PACKAGE_TIMEOUT_MS = 120_000;
const MAX_PACKAGE_TIMEOUT_MS = 30 * 60_000;
const CHILD_TERMINATION_GRACE_MS = 2_000;
const STALE_TEMP_AGE_MS = 24 * 60 * 60_000;
const SHA256_PATTERN = /^sha256-[a-f0-9]{64}$/;

function packageVariantKey(sourceKey) {
  return `${String(sourceKey || 'default')}:offline-mp3-v${OFFLINE_AUDIO_PACKAGE_VERSION}:br${OFFLINE_AUDIO_BITRATE_KBPS}k`;
}

function sourceVariantKey(packageKey) {
  const suffix = `:offline-mp3-v${OFFLINE_AUDIO_PACKAGE_VERSION}:br${OFFLINE_AUDIO_BITRATE_KBPS}k`;
  const value = String(packageKey || '');
  if (!value.endsWith(suffix) || value.length <= suffix.length) {
    throw new TypeError('Invalid offline audio package identity');
  }
  return value.slice(0, -suffix.length);
}

function variantDigest(sourceKey) {
  return crypto.createHash('sha256').update(packageVariantKey(sourceKey)).digest('hex').slice(0, 16);
}

function abortError(message = 'Offline audio packaging was cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function normalizedSha256(value) {
  const clean = String(value || '').toLowerCase();
  if (SHA256_PATTERN.test(clean)) return clean;
  if (/^[a-f0-9]{64}$/.test(clean)) return `sha256-${clean}`;
  return '';
}

function quotedEtag(artifactId) {
  return `"${artifactId}"`;
}

function commandError(command, code, stderr) {
  const detail = String(stderr || '').trim().slice(-1000);
  const error = new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`);
  error.code = 'OFFLINE_PACKAGE_COMMAND_FAILED';
  return error;
}

function createSpawnRunner(spawn = spawnDefault) {
  return (command, args, { signal } = {}) => new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let killTimer = null;

    const collect = (target, count, update) => chunk => {
      if (count() >= 1024 * 1024) return;
      const buffer = Buffer.from(chunk);
      const retained = buffer.subarray(0, Math.max(0, (1024 * 1024) - count()));
      target.push(retained);
      update(retained.length);
    };
    child.stdout?.on('data', collect(stdout, () => stdoutBytes, value => { stdoutBytes += value; }));
    child.stderr?.on('data', collect(stderr, () => stderrBytes, value => { stderrBytes += value; }));

    const terminate = () => {
      if (settled || child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled && child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      }, CHILD_TERMINATION_GRACE_MS);
      killTimer.unref?.();
    };
    signal?.addEventListener('abort', terminate, { once: true });

    child.once('error', error => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', terminate);
      reject(signal?.aborted ? abortError() : error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', terminate);
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (signal?.aborted) reject(abortError());
      else if (code !== 0) reject(commandError(command, code, output.stderr));
      else resolve(output);
    });
  });
}

function createCommandRunner({ spawn, execFile, runCommand }) {
  if (typeof runCommand === 'function') return runCommand;
  if (typeof execFile === 'function') {
    return async (command, args, { signal } = {}) => {
      throwIfAborted(signal);
      const result = await execFile(command, args, { signal });
      throwIfAborted(signal);
      if (typeof result === 'string') return { stdout: result, stderr: '' };
      return result || { stdout: '', stderr: '' };
    };
  }
  return createSpawnRunner(spawn || spawnDefault);
}

function packageTimeoutMs(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return MAX_PACKAGE_TIMEOUT_MS;
  return Math.min(MAX_PACKAGE_TIMEOUT_MS, Math.max(MIN_PACKAGE_TIMEOUT_MS, Math.ceil(durationSeconds * 2 * 1000)));
}

function parseProbe(result) {
  let parsed;
  try {
    parsed = JSON.parse(String(result?.stdout || ''));
  } catch {
    throw new Error('ffprobe returned invalid offline audio metadata');
  }
  const stream = Array.isArray(parsed.streams)
    ? parsed.streams.find(candidate => candidate?.codec_type === 'audio') || parsed.streams[0]
    : null;
  const duration = Number(parsed.format?.duration ?? stream?.duration);
  return { parsed, stream, duration };
}

function validateOfflineProbe(result, expectedSize) {
  const { parsed, stream, duration } = parseProbe(result);
  if (
    stream?.codec_name !== 'mp3' ||
    Number(stream.sample_rate) !== OFFLINE_AUDIO_SAMPLE_RATE ||
    Number(stream.channels) !== OFFLINE_AUDIO_CHANNELS ||
    !Number.isFinite(duration) || duration <= 0
  ) throw new Error('Offline audio package has an invalid codec or format');
  const reportedSize = Number(parsed.format?.size);
  if (Number.isFinite(reportedSize) && reportedSize !== expectedSize) {
    throw new Error('Offline audio package metadata has the wrong size');
  }
  return duration;
}

async function computeIntegrity(audioPath, {
  createReadStream = fsNative.createReadStream,
  signal
} = {}) {
  throwIfAborted(signal);
  const whole = crypto.createHash('sha256');
  let block = crypto.createHash('sha256');
  const blockHashes = [];
  let blockBytes = 0;
  let size = 0;
  const readStream = createReadStream(audioPath);
  const abort = () => readStream.destroy?.(abortError());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of readStream) {
      throwIfAborted(signal);
      const chunk = Buffer.from(value);
      whole.update(chunk);
      size += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const length = Math.min(OFFLINE_AUDIO_BLOCK_SIZE - blockBytes, chunk.length - offset);
        block.update(chunk.subarray(offset, offset + length));
        blockBytes += length;
        offset += length;
        if (blockBytes === OFFLINE_AUDIO_BLOCK_SIZE) {
          blockHashes.push(`sha256-${block.digest('hex')}`);
          block = crypto.createHash('sha256');
          blockBytes = 0;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  throwIfAborted(signal);
  if (blockBytes > 0) blockHashes.push(`sha256-${block.digest('hex')}`);
  if (size <= 0 || blockHashes.length === 0) throw new Error('Offline audio package is empty');
  return {
    size,
    artifactId: `sha256-${whole.digest('hex')}`,
    blockSize: OFFLINE_AUDIO_BLOCK_SIZE,
    blockHashes
  };
}

function createSemaphore(limit) {
  const capacity = Math.max(1, Math.floor(Number(limit) || 1));
  const waiters = [];
  let active = 0;
  async function acquire(signal) {
    throwIfAborted(signal);
    if (active < capacity) {
      active += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  }
  function release() {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.resolve();
      return;
    }
    active = Math.max(0, active - 1);
  }
  return async (task, signal) => {
    await acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  };
}

const processPackageSlot = createSemaphore(2);

async function waitWithSignal(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function createOfflineAudioPackage({
  cacheDir,
  fs = fsp,
  createReadStream = fsNative.createReadStream,
  createWriteStream = fsNative.createWriteStream,
  spawn,
  execFile,
  runCommand,
  maxConcurrentJobs = 2,
  beforePublish = async () => {},
  now = Date.now
} = {}) {
  if (!cacheDir) throw new TypeError('Offline audio package requires a cache directory');
  if (!fs?.stat || !fs?.rename || !fs?.unlink || !fs?.open) {
    throw new TypeError('Offline audio package requires filesystem operations');
  }
  const root = path.resolve(cacheDir);
  const execute = createCommandRunner({ spawn, execFile, runCommand });
  const withPackageSlot = Number(maxConcurrentJobs) === 2
    ? processPackageSlot
    : createSemaphore(maxConcurrentJobs);
  const jobs = new Map();
  const chapterJobs = new Map();
  const bookEpochs = new Map();
  const bookInvocations = new Map();
  const activeTemps = new Set();
  let cleanupStarted = false;

  function chapterPath({ bookId, chapterIndex, sourceVariantKey }) {
    if (!isSafeBookId(bookId)) throw new TypeError('Invalid book identifier');
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new TypeError('Invalid chapter index');
    return path.join(root, `${bookId}_offline_${variantDigest(sourceVariantKey)}_ch${chapterIndex}.mp3`);
  }

  function integrityPath(request) {
    return `${chapterPath(request)}.offline-integrity.json`;
  }

  function immutablePath(request, artifactId) {
    const digest = normalizedSha256(artifactId).slice('sha256-'.length);
    return chapterPath(request).replace(/\.mp3$/, `_sha256-${digest}.mp3`);
  }

  function baseResult(request, overrides = {}) {
    return {
      ready: false,
      size: 0,
      path: chapterPath(request),
      bitrateKbps: OFFLINE_AUDIO_BITRATE_KBPS,
      sampleRate: OFFLINE_AUDIO_SAMPLE_RATE,
      channels: OFFLINE_AUDIO_CHANNELS,
      variantKey: packageVariantKey(request.sourceVariantKey),
      artifactId: '',
      contentHash: '',
      etag: '',
      blockSize: OFFLINE_AUDIO_BLOCK_SIZE,
      blockHashes: [],
      provenance: 'legacy-unverified',
      sourceFingerprint: '',
      associatedRecipeFingerprint: '',
      url: null,
      ...overrides
    };
  }

  async function readCommittedSidecar(request) {
    let sidecar;
    try {
      sidecar = JSON.parse(await fs.readFile(integrityPath(request), 'utf8'));
    } catch {
      return null;
    }
    if (
      sidecar?.schemaVersion !== OFFLINE_INTEGRITY_SCHEMA_VERSION ||
      !SHA256_PATTERN.test(String(sidecar.artifactId || '')) ||
      sidecar.contentHash !== sidecar.artifactId ||
      sidecar.etag !== quotedEtag(sidecar.artifactId) ||
      sidecar.blockSize !== OFFLINE_AUDIO_BLOCK_SIZE ||
      !Array.isArray(sidecar.blockHashes) || sidecar.blockHashes.length === 0 ||
      sidecar.blockHashes.length !== Math.ceil(sidecar.size / OFFLINE_AUDIO_BLOCK_SIZE) ||
      !sidecar.blockHashes.every(hash => SHA256_PATTERN.test(String(hash || ''))) ||
      !Number.isInteger(sidecar.size) || sidecar.size <= 0 ||
      !['verified', 'legacy-unverified'].includes(sidecar.provenance) ||
      !SHA256_PATTERN.test(String(sidecar.sourceFingerprint || '')) ||
      (
        !['', undefined].includes(sidecar.associatedRecipeFingerprint) &&
        !SHA256_PATTERN.test(String(sidecar.associatedRecipeFingerprint || ''))
      ) ||
      sidecar.variantKey !== packageVariantKey(request.sourceVariantKey) ||
      sidecar.bitrateKbps !== OFFLINE_AUDIO_BITRATE_KBPS ||
      sidecar.sampleRate !== OFFLINE_AUDIO_SAMPLE_RATE ||
      sidecar.channels !== OFFLINE_AUDIO_CHANNELS ||
      typeof sidecar.file !== 'string' || path.basename(sidecar.file) !== sidecar.file
    ) return null;
    const expectedPath = immutablePath(request, sidecar.artifactId);
    if (path.basename(expectedPath) !== sidecar.file) return null;
    let stat;
    try {
      stat = await fs.stat(expectedPath);
    } catch {
      return null;
    }
    if (stat.isFile?.() === false || stat.size !== sidecar.size) return null;
    if (Number.isFinite(sidecar.mtimeMs) && Math.abs(Number(stat.mtimeMs) - Number(sidecar.mtimeMs)) > 1) return null;
    return { sidecar, path: expectedPath };
  }

  function committedMatchesRequest(committed, requestedFingerprint) {
    if (!committed || !requestedFingerprint) return Boolean(committed);
    const fingerprint = committed.sidecar.provenance === 'verified'
      ? committed.sidecar.sourceFingerprint
      : committed.sidecar.associatedRecipeFingerprint;
    return fingerprint === requestedFingerprint;
  }

  async function inspectChapter(request) {
    const committed = await readCommittedSidecar(request);
    const requestedFingerprint = normalizedSha256(request.sourceFingerprint);
    if (committedMatchesRequest(committed, requestedFingerprint)) {
      const sidecar = committed.sidecar;
      return baseResult(request, {
        ready: true,
        size: sidecar.size,
        path: committed.path,
        artifactId: sidecar.artifactId,
        contentHash: sidecar.contentHash,
        etag: sidecar.etag,
        blockSize: sidecar.blockSize,
        blockHashes: sidecar.blockHashes.slice(),
        provenance: sidecar.provenance,
        sourceFingerprint: sidecar.sourceFingerprint,
        associatedRecipeFingerprint: sidecar.associatedRecipeFingerprint || '',
        url: `/api/offline/audio/${encodeURIComponent(request.bookId)}/${request.chapterIndex}` +
          `?variant=${encodeURIComponent(packageVariantKey(request.sourceVariantKey))}` +
          `&artifact=${encodeURIComponent(sidecar.artifactId)}`
      });
    }
    let legacySize = 0;
    try {
      const stat = await fs.stat(chapterPath(request));
      if (stat.isFile?.() !== false) legacySize = Math.max(0, Number(stat.size) || 0);
    } catch {}
    return baseResult(request, { legacySize });
  }

  async function probe(filePath, signal) {
    return execute('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,size:stream=codec_type,codec_name,sample_rate,channels,duration',
      '-of', 'json', filePath
    ], { signal });
  }

  async function validateDecode(filePath, signal) {
    await execute('ffmpeg', [
      '-hide_banner', '-v', 'error', '-xerror', '-threads', '1',
      '-i', filePath, '-f', 'null', '-'
    ], { signal });
  }

  async function encode(sourcePath, outputPath, signal) {
    await execute('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-xerror', '-y', '-i', sourcePath,
      '-map_metadata', '-1', '-vn', '-ac', String(OFFLINE_AUDIO_CHANNELS),
      '-ar', String(OFFLINE_AUDIO_SAMPLE_RATE), '-c:a', 'libmp3lame',
      '-b:a', `${OFFLINE_AUDIO_BITRATE_KBPS}k`, '-threads', '1', '-f', 'mp3', outputPath
    ], { signal });
  }

  async function syncFile(filePath) {
    const handle = await fs.open(filePath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function syncDirectory() {
    let handle;
    try {
      handle = await fs.open(root, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function uniquePath(base, suffix) {
    return `${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}${suffix}`;
  }

  function currentBookEpoch(bookId) {
    return bookEpochs.get(bookId) || 0;
  }

  function assertBookEpoch(bookId, epoch) {
    if (currentBookEpoch(bookId) !== epoch) throw abortError();
  }

  async function restoreSidecar(finalPath, previous) {
    if (previous === null) {
      await fs.unlink(finalPath).catch(() => {});
      await syncDirectory();
      return;
    }
    const temporary = uniquePath(finalPath, '.tmp');
    activeTemps.add(temporary);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(previous);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, finalPath);
      await syncDirectory();
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      activeTemps.delete(temporary);
    }
  }

  async function writeSidecar(request, sidecar, signal, assertCurrent) {
    throwIfAborted(signal);
    const finalPath = integrityPath(request);
    const previous = await fs.readFile(finalPath).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    const temporary = uniquePath(finalPath, '.tmp');
    activeTemps.add(temporary);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(sidecar));
      await handle.sync();
      await handle.close();
      handle = null;
      throwIfAborted(signal);
      await fs.rename(temporary, finalPath);
      try {
        await syncDirectory();
        throwIfAborted(signal);
        assertCurrent();
      } catch (error) {
        await restoreSidecar(finalPath, previous);
        throw error;
      }
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      activeTemps.delete(temporary);
    }
  }

  async function publishArtifact(request, sourcePath, integrity, { move = false, signal } = {}) {
    throwIfAborted(signal);
    const finalPath = immutablePath(request, integrity.artifactId);
    let existing = false;
    try {
      const stat = await fs.stat(finalPath);
      existing = stat.isFile?.() !== false && stat.size > 0;
    } catch {}
    if (existing) {
      const existingIntegrity = await computeIntegrity(finalPath, { createReadStream, signal });
      if (existingIntegrity.artifactId !== integrity.artifactId || existingIntegrity.size !== integrity.size) {
        throw new Error('Immutable offline audio artifact does not match its digest name');
      }
      if (move) await fs.unlink(sourcePath).catch(() => {});
    } else if (move) {
      await syncFile(sourcePath);
      throwIfAborted(signal);
      await fs.rename(sourcePath, finalPath);
    } else {
      try {
        await fs.link(sourcePath, finalPath);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const existingIntegrity = await computeIntegrity(finalPath, { createReadStream, signal });
          if (existingIntegrity.artifactId !== integrity.artifactId ||
              existingIntegrity.size !== integrity.size) {
            throw new Error('Immutable offline audio artifact does not match its digest name');
          }
        } else if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
          throw error;
        } else {
          const temporary = uniquePath(finalPath, '.tmp');
          activeTemps.add(temporary);
          try {
            await pipeline(
              createReadStream(sourcePath),
              createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
              { signal }
            );
            throwIfAborted(signal);
            await syncFile(temporary);
            throwIfAborted(signal);
            await fs.rename(temporary, finalPath);
          } finally {
            await fs.unlink(temporary).catch(() => {});
            activeTemps.delete(temporary);
          }
        }
      }
    }
    throwIfAborted(signal);
    await syncFile(finalPath);
    throwIfAborted(signal);
    await syncDirectory();
    return finalPath;
  }

  async function cleanupStaleTemps() {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const cutoff = now() - STALE_TEMP_AGE_MS;
    let removed = 0;
    for (const entry of entries) {
      if (entry?.isFile?.() === false) continue;
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!/_offline_[a-f0-9]{16}_ch\d+.*(?:\.part(?:\.mp3)?|\.tmp)$/.test(name)) continue;
      const candidate = path.join(root, name);
      if (activeTemps.has(candidate)) continue;
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat || Number(stat.mtimeMs) > cutoff) continue;
      await fs.unlink(candidate).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  function startCleanup() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void cleanupStaleTemps().catch(() => {});
  }

  async function performEnsure(request, signal, assertCurrent) {
    return withPackageSlot(async () => {
      throwIfAborted(signal);
      const legacyPath = chapterPath(request);
      const committed = await readCommittedSidecar(request);
      const requestedFingerprint = normalizedSha256(request.sourceFingerprint);
      if (committedMatchesRequest(committed, requestedFingerprint)) {
        return inspectChapter(request);
      }

      let legacyStat = null;
      if (!committed) {
        legacyStat = await fs.stat(legacyPath).catch(() => null);
        if (legacyStat?.isFile?.() === false || Number(legacyStat?.size) <= 0) legacyStat = null;
      }
      if (!legacyStat && !request.sourcePath) throw new TypeError('Offline audio package requires source audio');

      const controller = new AbortController();
      const relayAbort = () => controller.abort();
      signal?.addEventListener('abort', relayAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const startedAt = now();
      let timedOut = false;
      let timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, MAX_PACKAGE_TIMEOUT_MS);
      timeout.unref?.();
      let workingPath = legacyStat ? legacyPath : uniquePath(legacyPath, '.part.mp3');
      const temporaryPath = legacyStat ? null : workingPath;
      if (temporaryPath) activeTemps.add(temporaryPath);
      try {
        const sourceProbe = await probe(legacyStat ? legacyPath : request.sourcePath, controller.signal);
        const sourceDuration = parseProbe(sourceProbe).duration;
        clearTimeout(timeout);
        const remaining = Math.max(1, packageTimeoutMs(sourceDuration) - (now() - startedAt));
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, remaining);
        timeout.unref?.();

        if (!legacyStat) await encode(request.sourcePath, workingPath, controller.signal);
        const stat = await fs.stat(workingPath);
        if (stat.isFile?.() === false || !Number.isFinite(stat.size) || stat.size <= 0) {
          throw new Error('Offline audio transcode produced an empty file');
        }
        await validateDecode(workingPath, controller.signal);
        const outputProbe = await probe(workingPath, controller.signal);
        validateOfflineProbe(outputProbe, stat.size);
        const integrity = await computeIntegrity(workingPath, {
          createReadStream,
          signal: controller.signal
        });
        throwIfAborted(controller.signal);

        const finalPath = await publishArtifact(request, workingPath, integrity, {
          move: !legacyStat,
          signal: controller.signal
        });
        throwIfAborted(controller.signal);
        const finalStat = await fs.stat(finalPath);
        const provenance = request.provenance === 'verified' && requestedFingerprint
          && !legacyStat
          ? 'verified'
          : 'legacy-unverified';
        const sourceFingerprint = provenance === 'verified'
          ? requestedFingerprint
          : integrity.artifactId;
        const associatedRecipeFingerprint = requestedFingerprint || '';
        const guard = typeof request.beforePublish === 'function' ? request.beforePublish : beforePublish;
        assertCurrent();
        await guard({ ...request, signal: controller.signal });
        throwIfAborted(controller.signal);
        assertCurrent();
        await writeSidecar(request, {
          schemaVersion: OFFLINE_INTEGRITY_SCHEMA_VERSION,
          artifactId: integrity.artifactId,
          contentHash: integrity.artifactId,
          etag: quotedEtag(integrity.artifactId),
          size: integrity.size,
          blockSize: integrity.blockSize,
          blockHashes: integrity.blockHashes,
          sourceFingerprint,
          associatedRecipeFingerprint,
          provenance,
          variantKey: packageVariantKey(request.sourceVariantKey),
          bitrateKbps: OFFLINE_AUDIO_BITRATE_KBPS,
          sampleRate: OFFLINE_AUDIO_SAMPLE_RATE,
          channels: OFFLINE_AUDIO_CHANNELS,
          file: path.basename(finalPath),
          mtimeMs: Number(finalStat.mtimeMs),
          createdAt: now()
        }, controller.signal, assertCurrent);
        return inspectChapter(request);
      } catch (error) {
        if (timedOut && error?.name === 'AbortError') {
          const timeoutError = new Error('Offline audio packaging timed out');
          timeoutError.code = 'OFFLINE_PACKAGE_TIMEOUT';
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', relayAbort);
        if (temporaryPath) {
          await fs.unlink(temporaryPath).catch(() => {});
          activeTemps.delete(temporaryPath);
        }
      }
    }, signal);
  }

  function requestIdentity(request) {
    return `${chapterPath(request)}\0${normalizedSha256(request.sourceFingerprint) || 'legacy'}`;
  }

  function attachConsumer(entry, request) {
    const signal = request.signal;
    throwIfAborted(signal);
    const consumer = Symbol('offline-package-consumer');
    entry.consumers.set(consumer, {
      beforePublish: typeof request.beforePublish === 'function' ? request.beforePublish : null,
      signal
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        entry.consumers.delete(consumer);
        callback(value);
      };
      const onAbort = () => {
        finish(reject, abortError());
        if (entry.consumers.size === 0) entry.controller.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  async function ensureChapterInvocation(request, epoch) {
    const assertCurrent = () => assertBookEpoch(request.bookId, epoch);
    assertCurrent();
    const existing = await inspectChapter(request);
    throwIfAborted(request.signal);
    assertCurrent();
    if (existing.ready) return existing;
    const identity = requestIdentity(request);
    const same = jobs.get(identity);
    if (same) {
      if (same.epoch === epoch) return attachConsumer(same, request);
      await waitWithSignal(same.promise.catch(() => {}), request.signal);
      assertCurrent();
      return ensureChapterInvocation(request, epoch);
    }

    const stablePath = chapterPath(request);
    const different = chapterJobs.get(stablePath);
    if (different) {
      await waitWithSignal(different.promise.catch(() => {}), request.signal);
      throwIfAborted(request.signal);
      assertCurrent();
      return ensureChapterInvocation(request, epoch);
    }

    const controller = new AbortController();
    const entry = {
      bookId: request.bookId,
      identity,
      epoch,
      controller,
      consumers: new Map(),
      promise: null
    };
    const guardedRequest = {
      ...request,
      signal: controller.signal,
      beforePublish: async current => {
        assertCurrent();
        await beforePublish(current);
        assertCurrent();
        const consumers = [...entry.consumers.entries()];
        if (consumers.length === 0) throw abortError();
        let lastError = null;
        for (const [consumerId, consumer] of consumers) {
          if (!entry.consumers.has(consumerId) || consumer.signal?.aborted) continue;
          if (!consumer.beforePublish) return;
          try {
            await consumer.beforePublish({ ...current, signal: consumer.signal || current.signal });
            if (entry.consumers.get(consumerId) === consumer && !consumer.signal?.aborted) return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || abortError();
      }
    };
    entry.promise = performEnsure(guardedRequest, controller.signal, assertCurrent).finally(() => {
      jobs.delete(identity);
      if (chapterJobs.get(stablePath) === entry) chapterJobs.delete(stablePath);
    });
    entry.promise.catch(() => {});
    jobs.set(identity, entry);
    chapterJobs.set(stablePath, entry);
    try {
      return attachConsumer(entry, request);
    } catch (error) {
      if (entry.consumers.size === 0) controller.abort();
      throw error;
    }
  }

  function ensureChapter(request) {
    chapterPath(request);
    startCleanup();
    const epoch = currentBookEpoch(request.bookId);
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    request.signal?.addEventListener('abort', relayAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const invocation = { controller, promise: null };
    let invocations = bookInvocations.get(request.bookId);
    if (!invocations) {
      invocations = new Set();
      bookInvocations.set(request.bookId, invocations);
    }
    invocations.add(invocation);
    const trackedRequest = { ...request, signal: controller.signal };
    invocation.promise = ensureChapterInvocation(trackedRequest, epoch).finally(() => {
      request.signal?.removeEventListener('abort', relayAbort);
      invocations.delete(invocation);
      if (invocations.size === 0) bookInvocations.delete(request.bookId);
    });
    return invocation.promise;
  }

  async function cancelBook(bookId) {
    bookEpochs.set(bookId, currentBookEpoch(bookId) + 1);
    const invocations = [...(bookInvocations.get(bookId) || [])];
    const matches = [...jobs.values()].filter(entry => entry.bookId === bookId);
    for (const invocation of invocations) invocation.controller.abort();
    for (const entry of matches) entry.controller.abort();
    await Promise.allSettled([
      ...invocations.map(invocation => invocation.promise),
      ...matches.map(entry => entry.promise)
    ]);
    return invocations.length || matches.length;
  }

  async function waitForIdle(bookId) {
    while (true) {
      const matches = [...jobs.values()].filter(entry => entry.bookId === bookId);
      const invocations = [...(bookInvocations.get(bookId) || [])];
      if (matches.length === 0 && invocations.length === 0) return;
      await Promise.allSettled([
        ...matches.map(entry => entry.promise),
        ...invocations.map(invocation => invocation.promise)
      ]);
    }
  }

  return {
    chapterPath,
    integrityPath,
    inspectChapter,
    ensureChapter,
    cancelBook,
    waitForIdle,
    cleanupStaleTemps,
    packageVariantKey,
    sourceVariantKey
  };
}

module.exports = {
  OFFLINE_AUDIO_BITRATE_KBPS,
  OFFLINE_AUDIO_BLOCK_SIZE,
  OFFLINE_AUDIO_CHANNELS,
  OFFLINE_AUDIO_PACKAGE_VERSION,
  OFFLINE_AUDIO_SAMPLE_RATE,
  createOfflineAudioPackage,
  computeIntegrity,
  packageTimeoutMs,
  packageVariantKey,
  sourceVariantKey
};
