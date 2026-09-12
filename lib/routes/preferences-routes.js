const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { DEFAULT_ANNAS_ORIGIN, validateAnnasOrigin } = require('../annas-origin');
const defaultJsonStore = require('../json-store');
const { requireAdmin: defaultRequireAdmin } = require('../auth');
const { synthesizeEdgeTts } = require('../abortable-edge-tts');
const { sendError, internalError, badRequest, notFound, forbidden, conflict, unavailable } = require('../http-error');

const cloneUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const ENGINE_STATUS_TTL_MS = 30000;
const ENGINE_STATUS_FAILURE_TTL_MS = 2000;
let engineStatusCache = { expiresAt: 0, value: null };

function sendRouteError(res, error, publicMessage, statusCode = 500, label = 'Preferences route') {
  console.error(`${label} failed:`, error);
  return sendError(res, statusCode, publicMessage);
}

const ZLIBRARY_ERROR_STATUS = Object.freeze({
  ZLIB_NOT_CONFIGURED: 409,
  ZLIB_AUTH_INVALID: 401,
  ZLIB_AUTH_EXPIRED: 401,
  ZLIB_TIMEOUT: 504,
  ZLIB_UNAVAILABLE: 503,
  ZLIB_RATE_LIMITED: 429,
  ZLIB_DAILY_LIMIT: 429,
  ZLIB_PROTOCOL: 502,
  ZLIB_DOWNLOAD_INVALID: 502
});

function sendZLibraryRouteError(res, error, fallbackMessage, fallbackStatus, label) {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const statusCode = code && ZLIBRARY_ERROR_STATUS[code]
    ? ZLIBRARY_ERROR_STATUS[code]
    : fallbackStatus;
  const publicMessage = typeof error?.publicMessage === 'string' && error.publicMessage.trim()
    ? error.publicMessage
    : fallbackMessage;

  // Z-Library errors can carry upstream bodies or token-bearing URLs in their cause.
  // Log only the stable code here rather than serializing the error object.
  console.error(`${label} failed: ${code || 'unexpected error'}`);
  return sendError(res, statusCode, publicMessage, code);
}

function resetEngineStatusCache() {
  engineStatusCache = { expiresAt: 0, value: null };
}

function engineBaseUrl(engine) {
  if (engine === 'kokoro') return (process.env.KOKORO_TTS_URL || 'http://127.0.0.1:8766').replace(/\/+$/, '');
  if (engine === 'chatterbox') return (process.env.CHATTERBOX_TTS_URL || 'http://127.0.0.1:8767').replace(/\/+$/, '');
  return '';
}

async function fetchEngineHealth(engine, processHint = false) {
  try {
    const response = await fetch(`${engineBaseUrl(engine)}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => ({}));
    return {
      up: true,
      status: 'online',
      process: Boolean(processHint),
      device: data.device,
      voices: data.voices
    };
  } catch (err) {
    return {
      up: false,
      status: processHint ? 'starting' : 'offline',
      process: Boolean(processHint),
      error: 'Health check failed'
    };
  }
}

function engineStatusTtl(value) {
  const engines = value?.engines || {};
  return Object.values(engines).every(engine => engine?.up)
    ? ENGINE_STATUS_TTL_MS
    : ENGINE_STATUS_FAILURE_TTL_MS;
}

function normalizeCloneName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function displayCloneName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function audioMagic(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const head4 = buffer.subarray(0, 4).toString('ascii');
  if (head4 === 'RIFF' && buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (head4 === 'fLaC') return 'flac';
  if (head4 === 'OggS') return 'ogg';
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'mp3';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  return null;
}

function uploadCloneAudio(req, res, next) {
  cloneUpload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 400, 'File too large', undefined, { details: 'Maximum upload size is 20 MB.' });
    }
    return sendError(res, 400, 'Upload failed', undefined, { details: 'The audio upload could not be processed.' });
  });
}

function registerPreferencesRoutes(app, {
  annasAuthFile,
  availableVoices,
  cacheDir,
  chatterboxVoicesEnabled,
  customVoicesFile,
  customVoiceDir,
  defaultVoice,
  getAvailableVoices,
  getAnnasConfig,
  validateAnnasOrigin: validateAnnasOriginForRoute = validateAnnasOrigin,
  getEngineProcessHints,
  getCurrentVoice,
  gutenberg,
  loadJSON,
  onVoiceSelected,
  prepareVoiceProvider,
  sampleText,
  saveJSON,
  settingsFile,
  TTSQueue,
  updateSettingsCache,
  updateCustomVoiceRegistry = () => {},
  voiceSamplesDir,
  voiceSampleGenerator = null,
  zlibrary,
  // Injectable so route-level unit tests can exercise the handler bodies
  // without standing up an authenticated session. Production always gets the
  // real guard from lib/auth.
  requireAdmin = defaultRequireAdmin,
  // Injectable alongside loadJSON/saveJSON so a test double can back the
  // locked read-modify-write path with the same state the reads see.
  jsonStore = defaultJsonStore
}) {
  async function getEngineStatus({ refresh = false } = {}) {
    const now = Date.now();
    if (refresh) resetEngineStatusCache();
    if (engineStatusCache.value && engineStatusCache.expiresAt > now) {
      return engineStatusCache.value;
    }
    if (prepareVoiceProvider && getCurrentVoice) {
      prepareVoiceProvider(getCurrentVoice());
    }
    const hints = getEngineProcessHints ? getEngineProcessHints() : {};
    const value = {
      engines: {
        kokoro: await fetchEngineHealth('kokoro', hints.kokoro),
        chatterbox: await fetchEngineHealth('chatterbox', hints.chatterbox),
        edge: { up: true }
      }
    };
    engineStatusCache = { value, expiresAt: now + engineStatusTtl(value) };
    return value;
  }

  app.get('/api/voices', async (req, res) => {
    try {
      const settings = await loadJSON(settingsFile, {});
      const currentVoice = settings.voice || defaultVoice;
      const voices = getAvailableVoices ? await getAvailableVoices() : availableVoices;
      res.json({
        voices,
        current: currentVoice
      });
    } catch (err) {
      sendRouteError(res, err, 'Failed to load voices', 500, 'Voice catalog');
    }
  });

  // Concurrent requests for the same uncached voiceId share one generation
  // instead of racing multiple ffmpeg/TTS writers against the same output
  // path (which could otherwise interleave and poison the cached sample).
  const voiceSampleInFlight = new Map();

  async function generateVoiceSample(voiceId, samplePath, signal) {
    const tempPath = `${samplePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    console.log(`Generating voice sample for ${voiceId}...`);
    if (prepareVoiceProvider) {
      prepareVoiceProvider(voiceId);
    }
    try {
      if (voiceSampleGenerator) {
        await voiceSampleGenerator({ voiceId, outputPath: tempPath, signal });
      } else if (voiceId.startsWith('kokoro:')) {
        const tempQueue = new TTSQueue({ maxConcurrent: 1, cacheDir, timeout: 30000 });
        const kokoroVoice = voiceId.slice('kokoro:'.length);
        await tempQueue._generateKokoroTTS(
          sampleText, tempPath, TTSQueue.getKokoroLanguage('en', kokoroVoice), kokoroVoice, 0, 0, signal
        );
      } else if (voiceId.startsWith('chatterbox:')) {
        const timeout = Number(process.env.CHATTERBOX_SAMPLE_TIMEOUT_MS || process.env.CHATTERBOX_TIMEOUT_MS || 180000);
        const tempQueue = new TTSQueue({ maxConcurrent: 1, cacheDir, timeout });
        await tempQueue._generateChatterboxTTS(
          sampleText, tempPath, voiceId.slice('chatterbox:'.length), 0, 0, signal
        );
      } else {
        const { EdgeTTS } = require('node-edge-tts');
        const tts = new EdgeTTS({
          voice: voiceId,
          lang: 'en-US',
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          timeout: 30000
        });
        await synthesizeEdgeTts(tts, sampleText, tempPath, signal);
      }
      if (signal?.aborted) {
        const error = new Error('Voice sample generation cancelled');
        error.name = 'AbortError';
        throw error;
      }
      await fs.rename(tempPath, samplePath);
      console.log(`Voice sample generated: ${voiceId}`);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  function getVoiceSampleJob(voiceId, samplePath) {
    let entry = voiceSampleInFlight.get(voiceId);
    if (entry) return entry;
    const controller = new AbortController();
    entry = { controller, waiters: 0, settled: false, promise: null };
    entry.promise = generateVoiceSample(voiceId, samplePath, controller.signal).finally(() => {
      entry.settled = true;
      if (voiceSampleInFlight.get(voiceId) === entry) voiceSampleInFlight.delete(voiceId);
    });
    voiceSampleInFlight.set(voiceId, entry);
    return entry;
  }

  async function waitForVoiceSample(req, res, voiceId, samplePath) {
    const entry = getVoiceSampleJob(voiceId, samplePath);
    entry.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    };
    req.once?.('aborted', release);
    res.once?.('close', release);
    try {
      return await entry.promise;
    } finally {
      req.off?.('aborted', release);
      res.off?.('close', release);
      release();
    }
  }

  app.get('/api/voice-sample/:voiceId', async (req, res) => {
    try {
      const voiceId = req.params.voiceId;
      const voices = getAvailableVoices ? await getAvailableVoices() : availableVoices;
      if (!voices.find(v => v.id === voiceId)) {
        return notFound(res, 'Voice not found');
      }

      await fs.mkdir(voiceSamplesDir, { recursive: true });
      const samplePath = path.join(voiceSamplesDir, `${voiceId}.mp3`);

      let cached = true;
      try {
        await fs.access(samplePath);
      } catch {
        cached = false;
      }

      if (!cached) {
        // Short-circuit local engines that are already known to be down
        // rather than entering a 30-180s retry loop per request.
        if (voiceId.startsWith('kokoro:') || voiceId.startsWith('chatterbox:')) {
          const engine = voiceId.startsWith('kokoro:') ? 'kokoro' : 'chatterbox';
          const status = await getEngineStatus();
          if (status.engines?.[engine]?.up === false) {
            return unavailable(res, 'Narration engine is unavailable', 'ENGINE_UNAVAILABLE');
          }
        }
        await waitForVoiceSample(req, res, voiceId, samplePath);
      }

      res.sendFile(samplePath);
    } catch (err) {
      if (err?.name === 'AbortError' && (req.aborted || res.destroyed)) return;
      console.error('Voice sample error:', err);
      return sendRouteError(res, err, 'Failed to generate voice sample', 500, 'Voice sample');
    }
  });

  app.post('/api/voice', async (req, res) => {
    try {
      const { voiceId } = req.body;
      const voices = getAvailableVoices ? await getAvailableVoices() : availableVoices;
      if (!voiceId || !voices.find(v => v.id === voiceId)) {
        return badRequest(res, 'Invalid voice');
      }

      const settings = await jsonStore.update(settingsFile, data => {
        data.voice = voiceId;
        return data;
      }, {});
      updateSettingsCache(settings);
      if (onVoiceSelected) {
        onVoiceSelected(voiceId);
      }
      resetEngineStatusCache();
      res.json({ success: true, voice: voiceId });
    } catch (err) {
      sendRouteError(res, err, 'Failed to select voice', 500, 'Voice selection');
    }
  });

  app.get('/api/engines/status', async (req, res) => {
    try {
      res.json(await getEngineStatus({ refresh: req.query.refresh === '1' }));
    } catch (err) {
      sendRouteError(res, err, 'Failed to check narration engines', 500, 'Engine status');
    }
  });

  app.post('/api/voices/clone', requireAdmin, uploadCloneAudio, async (req, res) => {
    try {
      if (!customVoicesFile || !customVoiceDir) {
        return internalError(res, 'Custom voices are not configured');
      }
      if (chatterboxVoicesEnabled === false) {
        return forbidden(res, 'Voice cloning is not available on this instance (Chatterbox is not an enabled voice provider).', 'VOICE_PROVIDER_DISABLED');
      }
      if (req.body?.authorityConfirmed !== 'true') {
        return badRequest(res, 'Confirm that you have authority and any required consent to use this voice reference.', 'VOICE_AUTHORITY_CONFIRMATION_REQUIRED');
      }
      if (!req.file?.buffer?.length) {
        return badRequest(res, 'Audio file is required');
      }
      const ext = audioMagic(req.file.buffer);
      if (!ext) {
        return sendError(res, 400, 'Unsupported audio file', undefined, { details: 'Upload WAV, MP3, M4A, FLAC, or OGG audio.' });
      }
      const rawName = displayCloneName(req.body?.name);
      const id = normalizeCloneName(rawName);
      if (!/^[a-z0-9-_]{1,40}$/.test(id)) {
        return badRequest(res, 'Use 1-40 letters, numbers, hyphens, or underscores for the voice name.');
      }

      await fs.mkdir(customVoiceDir, { recursive: true });
      const registrySnapshot = await loadJSON(customVoicesFile, { voices: [] });
      if ((registrySnapshot.voices || []).some(voice => voice.id === id) || id === 'brick-scott') {
        return conflict(res, 'A custom voice with that name already exists.');
      }

      // Write the (up to 20 MB) reference file to disk before taking the
      // registry lock, so the lock is only held for the JSON update itself.
      const tempName = `${id}-${crypto.randomBytes(6).toString('hex')}.${ext}.tmp`;
      const tempPath = path.join(customVoiceDir, tempName);
      const finalPath = path.join(customVoiceDir, `${id}.${ext}`);
      await fs.writeFile(tempPath, req.file.buffer, { mode: 0o600 });
      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, finalPath);
      await fs.chmod(finalPath, 0o600);
      const voice = {
        id,
        name: rawName || id,
        ext,
        refVersion: Date.now(),
        createdAt: new Date().toISOString(),
        // Attribution. Both clone routes are admin-gated today, so this is
        // recorded rather than enforced; it is what an ownership check would
        // need if creation is ever reopened to members. Null in trusted-LAN
        // and shared-token modes, where there is no account identity.
        createdBy: req.user?.id || null
      };
      let registryConflict = false;
      const updatedRegistry = await jsonStore.update(customVoicesFile, registry => {
        const voices = Array.isArray(registry.voices) ? registry.voices : [];
        if (voices.some(item => item.id === id) || id === 'brick-scott') {
          registryConflict = true;
          return jsonStore.SKIP_SAVE;
        }
        voices.push(voice);
        registry.voices = voices;
        return registry;
      }, { voices: [] });
      if (registryConflict) {
        await fs.unlink(finalPath).catch(() => {});
        return conflict(res, 'A custom voice with that name already exists.');
      }
      updateCustomVoiceRegistry(updatedRegistry);
      res.status(201).json({ voice });
    } catch (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 400, 'File too large', undefined, { details: 'Maximum upload size is 20 MB.' });
      }
      sendRouteError(res, err, 'Failed to save custom voice', 500, 'Voice cloning');
    }
  });

  app.delete('/api/voices/clone/:id', requireAdmin, async (req, res) => {
    try {
      if (!customVoicesFile || !customVoiceDir) {
        return internalError(res, 'Custom voices are not configured');
      }
      const id = normalizeCloneName(req.params.id);
      if (!id || id === 'brick-scott') return badRequest(res, 'Voice cannot be deleted.');

      let removedExt = null;
      let found = false;
      const updatedRegistry = await jsonStore.update(customVoicesFile, registry => {
        const voices = Array.isArray(registry.voices) ? registry.voices : [];
        const voice = voices.find(item => item.id === id);
        if (!voice) return jsonStore.SKIP_SAVE;
        found = true;
        removedExt = voice.ext;
        registry.voices = voices.filter(item => item.id !== id);
        return registry;
      }, { voices: [] });
      if (!found) return notFound(res, 'Voice not found');
      updateCustomVoiceRegistry(updatedRegistry);

      await fs.unlink(path.join(customVoiceDir, `${id}.${removedExt}`)).catch(() => {});
      let settingsAfter = null;
      await jsonStore.update(settingsFile, settings => {
        if (settings.voice !== `chatterbox:${id}`) return jsonStore.SKIP_SAVE;
        settings.voice = defaultVoice;
        settingsAfter = settings;
        return settings;
      }, {});
      if (settingsAfter) updateSettingsCache(settingsAfter);
      res.json({ success: true });
    } catch (err) {
      sendRouteError(res, err, 'Failed to delete custom voice', 500, 'Voice deletion');
    }
  });

  app.post('/api/annas/configure', async (req, res) => {
    try {
      const { secretKey, baseUrl } = req.body;
      const normalizedKey = typeof secretKey === 'string' ? secretKey.trim() : '';
      if (!normalizedKey) {
        return badRequest(res, 'Secret key is required');
      }
      if (normalizedKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(normalizedKey)) {
        return badRequest(res, 'Secret key is invalid');
      }

      // A key saved here lands in the auth file, which getAnnasConfig
      // prefers over ANNAS_SECRET_KEY — so Settings can always override an
      // environment-managed key without a server restart.
      const existing = getAnnasConfig();
      const normalizedOrigin = await validateAnnasOriginForRoute(baseUrl || DEFAULT_ANNAS_ORIGIN);
      const updatedAt = new Date().toISOString();
      const config = {
        secretKey: normalizedKey,
        baseUrl: normalizedOrigin,
        updatedAt
      };
      await saveJSON(annasAuthFile, config);
      res.json({
        success: true,
        replaced: Boolean(existing.secretKey),
        overridesEnvironment: existing.keySource === 'environment',
        updatedAt
      });
    } catch (err) {
      if (/Anna’s Archive base URL/.test(String(err?.message || ''))) {
        return badRequest(res, err.message);
      }
      sendRouteError(res, err, 'Failed to save Anna’s Archive settings', 500, 'Anna’s Archive configuration');
    }
  });

  app.get('/api/annas/status', (req, res) => {
    const cfg = getAnnasConfig();
    res.json({
      configured: !!cfg.secretKey,
      baseUrl: cfg.baseUrl,
      hasKey: !!cfg.secretKey,
      keySource: cfg.keySource || null,
      updatedAt: cfg.updatedAt || null
    });
  });

  app.delete('/api/annas/configure', async (req, res) => {
    try {
      // Removing the Settings key falls back to ANNAS_SECRET_KEY when the
      // environment still provides one; the response reports what remains.
      await fs.unlink(annasAuthFile).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      const remaining = getAnnasConfig();
      res.json({
        success: true,
        configured: Boolean(remaining.secretKey),
        keySource: remaining.keySource || null
      });
    } catch (err) {
      sendRouteError(res, err, 'Failed to remove Anna’s Archive settings', 500, 'Anna’s Archive configuration removal');
    }
  });

  app.post('/api/zlibrary/configure', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return badRequest(res, 'Email and password required');
      }

      const status = await zlibrary.connect({ email, password });
      res.json({ success: true, ...status });
    } catch (err) {
      sendZLibraryRouteError(res, err, 'Unable to authenticate with Z-Library', 401, 'Z-Library configuration');
    }
  });

  app.delete('/api/zlibrary/configure', async (req, res) => {
    try {
      const status = await zlibrary.disconnect();
      res.json({ success: true, ...status });
    } catch (err) {
      sendZLibraryRouteError(res, err, 'Failed to disconnect Z-Library', 500, 'Z-Library configuration removal');
    }
  });

  app.get('/api/zlibrary/status', async (req, res) => {
    try {
      res.json(await zlibrary.getStatus());
    } catch (err) {
      sendZLibraryRouteError(res, err, 'Unable to verify Z-Library status', 503, 'Z-Library status');
    }
  });

  app.get('/api/gutenberg/status', (req, res) => {
    const enabled = gutenberg.isEnabled();
    res.json({
      enabled,
      source: 'gutenberg',
      description: 'Free public domain books - no account needed'
    });
  });

  app.post('/api/gutenberg/configure', async (req, res) => {
    try {
      const { enabled } = req.body;
      await gutenberg.setEnabled(!!enabled);
      res.json({ success: true, enabled: !!enabled });
    } catch (err) {
      sendRouteError(res, err, 'Failed to update Project Gutenberg settings', 500, 'Project Gutenberg configuration');
    }
  });

  return { getEngineStatus };
}

module.exports = {
  registerPreferencesRoutes,
  __test: {
    resetEngineStatusCache
  }
};
