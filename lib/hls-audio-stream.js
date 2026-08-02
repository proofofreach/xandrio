'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { MASTERING_POLICY } = require('./audio-quality');
const {
  captureStderr,
  createOutputPacer,
  decodeInto,
  killChild,
  pcmBytesForSeconds,
  waitForChild
} = require('./chapter-audio-stream');

const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
// One deadline contract, shared with the client.
//
// The client abandons a media load after CLIENT_LOAD_DEADLINE_MS (kept in sync
// with the exported constant of the same name in
// public/js/single-file-chapter-player.js, and asserted by
// test/test-playback-routes.js). Cancellation here is disconnect-driven:
// servePlaylist aborts the session controller on the request's 'aborted' event
// and the response's 'close' event, so a session the client has given up on
// dies within milliseconds and its waiter-less, not-yet-ready state evicts it.
//
// This timeout is therefore not the mechanism that reclaims abandoned work — it
// is the backstop for a socket that never closes (a proxy holding it open). It
// must stay above the client deadline, so a client that is still waiting never
// has its in-flight encoder destroyed underneath it, and low enough that a
// wedged socket cannot hold an ffmpeg process for minutes. It was five minutes,
// which no legitimate client could ever reach.
const CLIENT_LOAD_DEADLINE_MS = 30000;
const HLS_READY_TIMEOUT_MS = CLIENT_LOAD_DEADLINE_MS * 2;
const DEFAULT_MAX_ACTIVE_SESSIONS = 16;
const DEFAULT_SESSION_RETENTION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RETAINED_SESSIONS = 128;
const DEFAULT_MAX_STORAGE_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_CREATION_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_CREATIONS_PER_ACCOUNT = 12;
const SAFE_SEGMENT = /^(?:init\.mp4|segment-\d{6}\.m4s)$/;
const SAFE_SESSION = /^[a-f0-9-]{36}$/;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function statusError(statusCode, message, retryAfterSeconds = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
    error.retryAfterSeconds = retryAfterSeconds;
    error.retryAfter = retryAfterSeconds;
  }
  return error;
}

function abortError(message = 'HLS playlist request disconnected') {
  return Object.assign(new Error(message), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  });
}

function accountKeyForOwner(ownerKey) {
  const value = String(ownerKey || 'anonymous');
  const tierSeparator = value.lastIndexOf(':');
  if (tierSeparator < 0) return value;
  const withoutTier = value.slice(0, tierSeparator);
  const bookSeparator = withoutTier.lastIndexOf(':');
  return bookSeparator < 0 ? value : withoutTier.slice(0, bookSeparator);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function cleanupStaleSessionRoots({
  baseDir,
  currentPid = process.pid,
  isProcessAlive = processIsAlive
}) {
  let entries;
  try {
    entries = await fsp.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  await Promise.all(entries.map(async entry => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return;
    const pid = Number(entry.name);
    if (pid === currentPid || isProcessAlive(pid)) return;
    await fsp.rm(path.join(baseDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }));
  return removed;
}

async function directoryBytes(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await fsp.stat(entryPath)).size;
  }
  return total;
}

function hlsEncoderArgs(directory, segmentSeconds) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 's16le',
    '-ar', String(MASTERING_POLICY.sampleRate),
    '-ac', String(MASTERING_POLICY.channels),
    '-i', 'pipe:0',
    '-map_metadata', '-1',
    '-vn',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', String(MASTERING_POLICY.sampleRate),
    '-ac', String(MASTERING_POLICY.channels),
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(directory, 'segment-%06d.m4s'),
    '-hls_flags', 'independent_segments+temp_file',
    path.join(directory, 'index.m3u8')
  ];
}

function rewritePlaylist(playlist, sessionId) {
  const route = fileName => (
    `/api/audio-hls-segment/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}`
  );
  const rewritten = String(playlist)
    .replace(/URI="([^"]+)"/g, (_match, fileName) => `URI="${route(fileName)}"`)
    .split('\n')
    .map(line => line && !line.startsWith('#') ? route(line) : line)
    .join('\n');
  if (rewritten.includes('#EXT-X-START:')) return rewritten;
  return rewritten.replace(
    /(#EXT-X-PLAYLIST-TYPE:EVENT\n)/,
    '$1#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n'
  );
}

function createHlsAudioStreamer({
  serveAudioFile,
  spawnProcess = spawn,
  rootDir = path.join(os.tmpdir(), 'xandrio-hls', String(process.pid)),
  segmentSeconds = 4,
  readyTimeoutMs = HLS_READY_TIMEOUT_MS,
  maxActiveSessions = positiveInteger(
    process.env.XANDRIO_HLS_MAX_ACTIVE_SESSIONS,
    DEFAULT_MAX_ACTIVE_SESSIONS
  ),
  sessionIdleMs = 90 * 1000,
  sessionRetentionMs = DEFAULT_SESSION_RETENTION_MS,
  maxRetainedSessions = DEFAULT_MAX_RETAINED_SESSIONS,
  maxStorageBytes = positiveInteger(
    process.env.XANDRIO_HLS_MAX_STORAGE_BYTES,
    DEFAULT_MAX_STORAGE_BYTES
  ),
  creationWindowMs = DEFAULT_CREATION_WINDOW_MS,
  maxCreationsPerAccount = DEFAULT_MAX_CREATIONS_PER_ACCOUNT,
  maintenanceIntervalMs = 60 * 1000,
  // Diagnostics hook: called once per session when its first HLS segment
  // exists. Instrumentation only — nothing here changes scheduling.
  onFirstSegment = null,
  // Reports whether non-background TTS work was already running when a session
  // was admitted, so a slow first segment can be attributed rather than guessed.
  backgroundWorkProbe = null,
  now = Date.now
} = {}) {
  if (typeof serveAudioFile !== 'function') {
    throw new TypeError('createHlsAudioStreamer requires serveAudioFile');
  }

  const sessionsByKey = new Map();
  const sessionsById = new Map();
  const sessionsByOwner = new Map();
  const creationWindows = new Map();
  const rootName = path.basename(rootDir);
  const rootPid = /^\d+$/.test(rootName) ? Number(rootName) : null;
  const startupCleanupPromise = rootPid === null
    ? Promise.resolve([])
    : cleanupStaleSessionRoots({
        baseDir: path.dirname(rootDir),
        currentPid: rootPid
      }).catch(() => []);
  let maintenancePromise = null;
  let maintenanceTimer = null;
  let disposed = false;

  function removeSessionMappings(session) {
    sessionsById.delete(session.id);
    if (sessionsByKey.get(session.key) === session) sessionsByKey.delete(session.key);
    if (sessionsByOwner.get(session.ownerKey) === session) sessionsByOwner.delete(session.ownerKey);
  }

  function evictSession(session) {
    if (!session || session.evicted) return session?.cleanupPromise || Promise.resolve();
    session.evicted = true;
    removeSessionMappings(session);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    if (session.running) session.controller.abort();
    session.cleanupPromise = fsp.rm(session.directory, { recursive: true, force: true });
    const completion = Promise.resolve(session.runPromise || session.readyPromise).catch(() => {});
    void completion.finally(() => (
      fsp.rm(session.directory, { recursive: true, force: true }).catch(() => {})
    ));
    return session.cleanupPromise;
  }

  function touch(session) {
    if (session.evicted) return;
    session.lastAccessAt = now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!session.running || sessionIdleMs <= 0) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (session.running && now() - session.lastAccessAt >= sessionIdleMs) {
        void evictSession(session);
      }
    }, sessionIdleMs);
    session.idleTimer.unref?.();
  }

  function pruneCreationWindows(timestamp = now()) {
    const cutoff = timestamp - creationWindowMs;
    for (const [accountKey, timestamps] of creationWindows) {
      const retained = timestamps.filter(value => value > cutoff);
      if (retained.length) creationWindows.set(accountKey, retained);
      else creationWindows.delete(accountKey);
    }
  }

  function creationRateKey(ownerKey, rateKey) {
    return String(rateKey || accountKeyForOwner(ownerKey));
  }

  function assertCreationAllowed(ownerKey, rateKey) {
    if (maxCreationsPerAccount <= 0 || creationWindowMs <= 0) return;
    const timestamp = now();
    pruneCreationWindows(timestamp);
    const timestamps = creationWindows.get(creationRateKey(ownerKey, rateKey)) || [];
    if (timestamps.length >= maxCreationsPerAccount) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((timestamps[0] + creationWindowMs - timestamp) / 1000)
      );
      throw statusError(429, 'Too many HLS playback sessions started', retryAfterSeconds);
    }
  }

  function recordCreation(ownerKey, rateKey) {
    if (maxCreationsPerAccount <= 0 || creationWindowMs <= 0) return;
    const accountKey = creationRateKey(ownerKey, rateKey);
    const timestamps = creationWindows.get(accountKey) || [];
    timestamps.push(now());
    creationWindows.set(accountKey, timestamps);
  }

  async function maintain() {
    if (maintenancePromise) return maintenancePromise;
    maintenancePromise = (async () => {
      await startupCleanupPromise;
      const timestamp = now();
      pruneCreationWindows(timestamp);
      const cleanup = [];
      for (const session of [...sessionsById.values()]) {
        if (
          session.running
          && sessionIdleMs > 0
          && timestamp - session.lastAccessAt >= sessionIdleMs
        ) {
          cleanup.push(evictSession(session));
        }
      }

      const inactive = [...sessionsById.values()]
        .filter(session => !session.running)
        .sort((left, right) => right.lastAccessAt - left.lastAccessAt);
      const retainedInactive = inactive.filter(session => (
        sessionRetentionMs > 0
        && timestamp - session.lastAccessAt < sessionRetentionMs
      ));
      const retainedSet = new Set(
        retainedInactive.slice(0, Math.max(0, maxRetainedSessions))
      );
      for (const session of inactive) {
        if (!retainedSet.has(session)) cleanup.push(evictSession(session));
      }

      if (maxStorageBytes > 0) {
        const sessions = [...sessionsById.values()];
        const sizes = await Promise.all(sessions.map(async session => ({
          session,
          bytes: await directoryBytes(session.directory)
        })));
        let totalBytes = sizes.reduce((sum, item) => sum + item.bytes, 0);
        const oldestFirst = sizes.sort((left, right) => (
          Number(left.session.running) - Number(right.session.running)
          || left.session.lastAccessAt - right.session.lastAccessAt
        ));
        for (const item of oldestFirst) {
          if (totalBytes <= maxStorageBytes) break;
          totalBytes -= item.bytes;
          cleanup.push(evictSession(item.session));
        }
      }
      await Promise.all(cleanup);
    })().finally(() => {
      maintenancePromise = null;
    });
    return maintenancePromise;
  }

  function createSession(key, ownerKey, rateKey, createSource) {
    const prior = ownerKey ? sessionsByOwner.get(ownerKey) : null;
    assertCreationAllowed(ownerKey, rateKey);
    const activeSessions = [...sessionsById.values()].filter(session => session.running).length;
    const replacesActiveSession = Boolean(
      prior && prior.key !== key && prior.running && sessionsById.has(prior.id)
    );
    if (activeSessions - Number(replacesActiveSession) >= maxActiveSessions) {
      throw statusError(503, 'HLS playback capacity is temporarily full');
    }
    if (prior && prior.key !== key) void evictSession(prior);
    recordCreation(ownerKey, rateKey);
    const id = crypto.randomUUID();
    const directory = path.join(rootDir, id);
    const session = {
      id,
      key,
      ownerKey,
      directory,
      playlistPath: path.join(directory, 'index.m3u8'),
      createdAt: now(),
      lastAccessAt: now(),
      running: true,
      ready: false,
      waiters: 0,
      evicted: false,
      idleTimer: null,
      cleanupPromise: null,
      error: null,
      controller: new AbortController(),
      readyPromise: null,
      runPromise: null,
      backgroundWorkAtAdmission: (() => {
        try { return Boolean(backgroundWorkProbe?.()); } catch { return false; }
      })()
    };
    sessionsByKey.set(key, session);
    sessionsById.set(id, session);
    if (ownerKey) sessionsByOwner.set(ownerKey, session);

    session.readyPromise = (async () => {
      await startupCleanupPromise;
      await fsp.mkdir(directory, { recursive: true });
      if (session.controller.signal.aborted) throw abortError('HLS session was cancelled');
      const source = await createSource();
      if (session.controller.signal.aborted) throw abortError('HLS session was cancelled');
      const encoder = spawnProcess('ffmpeg', hlsEncoderArgs(directory, segmentSeconds), {
        stdio: ['pipe', 'ignore', 'pipe']
      });
      const stderr = captureStderr(encoder);
      const exit = waitForChild(
        encoder,
        'HLS audio encoder',
        stderr,
        session.controller.signal
      );
      const abort = () => killChild(encoder);
      session.controller.signal.addEventListener('abort', abort, { once: true });

      const pacing = source.outputPacing || {
        burstAudioSeconds: 30,
        realtimeMultiplier: 1.5
      };
      const pace = createOutputPacer({ format: 'wav', ...pacing });
      const skipState = {
        remaining: pcmBytesForSeconds(
          source.decodeStartOffsetSeconds ?? source.startOffsetSeconds
        )
      };
      const input = (async () => {
        for await (const inputItem of source.iterateInputs(session.controller.signal)) {
          const descriptor = typeof inputItem === 'string'
            ? { path: inputItem }
            : inputItem;
          const skipBefore = skipState.remaining;
          const pcmBytes = await decodeInto(
            descriptor.path,
            encoder,
            session.controller.signal,
            spawnProcess,
            { pace, skipState }
          );
          const skippedPcmBytes = skipBefore - skipState.remaining;
          source.onInputDecoded?.(descriptor, pcmBytes, { skippedPcmBytes });
          if (descriptor.lastInChapter && descriptor.chapterIndex === source.chapterIndex) {
            skipState.remaining = 0;
          }
        }
        encoder.stdin.end();
      })();

      session.runPromise = Promise.all([input, exit])
        .catch(error => {
          session.error = error;
        })
        .finally(() => {
          session.running = false;
          if (session.idleTimer) clearTimeout(session.idleTimer);
          session.idleTimer = null;
          session.controller.signal.removeEventListener('abort', abort);
          killChild(encoder);
          if (!encoder.stdin.destroyed) encoder.stdin.destroy();
        });

      const startedAt = now();
      const deadline = startedAt + readyTimeoutMs;
      while (now() < deadline) {
        if (session.error) throw session.error;
        try {
          const stat = await fsp.stat(session.playlistPath);
          if (stat.size > 0) {
            session.ready = true;
            // Time to first segment is the number that decides whether the TTS
            // priority inversion is worth acting on. Measurement only — no
            // scheduling behaviour changes on it. See the thresholds recorded
            // in the incident plan before proposing preemption.
            //
            // Isolated deliberately: a diagnostic hook that throws must never
            // reject readiness or evict a session a listener is waiting on.
            try {
              onFirstSegment?.({
                key: session.key,
                waitedMs: now() - startedAt,
                backgroundWorkInFlight: Boolean(session.backgroundWorkAtAdmission)
              });
            } catch (diagnosticError) {
              console.warn(`HLS first-segment diagnostic failed: ${diagnosticError.message}`);
            }
            return session;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      session.controller.abort();
      throw new Error('Timed out waiting for the first HLS audio segment');
    })().catch(error => {
      session.error = error;
      session.running = false;
      if (!session.evicted) void evictSession(session);
      throw error;
    });
    session.readyPromise.catch(() => {});

    return session;
  }

  async function sessionFor(key, ownerKey, rateKey, createSource, signal = null) {
    void maintain().catch(() => {});
    let session = sessionsByKey.get(key);
    if (session?.error) {
      void evictSession(session);
      session = null;
    }
    if (!session) session = createSession(key, ownerKey, rateKey, createSource);
    session.waiters += 1;
    let disconnected = false;
    let onAbort;
    const disconnectedPromise = signal
      ? new Promise((_, reject) => {
          onAbort = () => {
            disconnected = true;
            reject(abortError());
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      : null;
    try {
      await (disconnectedPromise
        ? Promise.race([session.readyPromise, disconnectedPromise])
        : session.readyPromise);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      session.waiters = Math.max(0, session.waiters - 1);
      if (disconnected && !session.ready && session.waiters === 0) {
        void evictSession(session);
      }
    }
    touch(session);
    return session;
  }

  async function servePlaylist(req, res, {
    key,
    ownerKey = null,
    rateKey = null,
    createSource
  }) {
    const requestController = new AbortController();
    const disconnect = () => requestController.abort();
    req.once?.('aborted', disconnect);
    res.once?.('close', disconnect);
    let session;
    try {
      session = await sessionFor(
        key,
        ownerKey,
        rateKey,
        createSource,
        requestController.signal
      );
    } catch (error) {
      if (requestController.signal.aborted) return;
      if ((error.statusCode === 429 || error.statusCode === 503) && !res.headersSent) {
        if (error.retryAfterSeconds) {
          res.set('Retry-After', String(error.retryAfterSeconds));
        }
        return res.status(error.statusCode).json({ error: error.message });
      }
      throw error;
    } finally {
      req.off?.('aborted', disconnect);
      res.off?.('close', disconnect);
    }
    const playlist = rewritePlaylist(
      await fsp.readFile(session.playlistPath, 'utf8'),
      session.id
    );
    const body = Buffer.from(playlist);
    res.status(200);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
      'Content-Type': PLAYLIST_CONTENT_TYPE,
      'X-Accel-Buffering': 'no'
    });
    res.end(body);
  }

  async function serveSegment(req, res, sessionId, fileName) {
    if (!SAFE_SESSION.test(sessionId) || !SAFE_SEGMENT.test(fileName)) {
      return res.status(400).json({ error: 'Invalid HLS segment identifier' });
    }
    const session = sessionsById.get(sessionId);
    if (!session) return res.status(404).json({ error: 'HLS playback session expired' });
    touch(session);
    const filePath = path.join(session.directory, fileName);
    try {
      await fsp.access(filePath);
    } catch {
      return res.status(404).json({ error: 'HLS segment not ready' });
    }
    return serveAudioFile(req, res, filePath);
  }

  async function dispose() {
    disposed = true;
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    await Promise.all([...sessionsById.values()].map(evictSession));
    await fsp.rm(rootDir, { recursive: true, force: true });
    sessionsByKey.clear();
    sessionsById.clear();
    sessionsByOwner.clear();
    creationWindows.clear();
  }

  if (maintenanceIntervalMs > 0) {
    maintenanceTimer = setInterval(() => {
      if (!disposed) void maintain().catch(() => {});
    }, maintenanceIntervalMs);
    maintenanceTimer.unref?.();
  }

  return {
    servePlaylist,
    serveSegment,
    dispose,
    maintain,
    sessionsByKey,
    sessionsById,
    limits: {
      maxActiveSessions,
      maxCreationsPerAccount,
      maxRetainedSessions,
      maxStorageBytes
    }
  };
}

module.exports = {
  DEFAULT_MAX_ACTIVE_SESSIONS,
  accountKeyForOwner,
  cleanupStaleSessionRoots,
  createHlsAudioStreamer,
  hlsEncoderArgs,
  rewritePlaylist
};
