'use strict';

// Deep client telemetry for administrator sessions.
//
// The anonymous playback-health aggregate says *that* an installed app
// crashed or started slowly. It cannot say *why*. Administrators can opt
// their own devices into a detailed trail: boot phase timings, slow resource
// loads, main-thread stalls, decoded image pixels, offline-audio work, routes
// and script errors. The client persists the trail in localStorage while it
// runs, so the trail of a session that iOS killed is uploaded on the next
// launch with its exit classification.
//
// Only administrators can write or read these records. Each session is
// bounded in size and the store keeps the most recent sessions only.
//
// The server half is a trail of slow responses (time to first byte) and
// event-loop stalls, so a slow client phase can be matched to server work.

const REPORT_VERSION = 1;
const MAX_SESSIONS = 80;
const RETENTION_DAYS = 30;
const MAX_EVENTS = 600;
const MAX_FIELDS = 16;
const MAX_STRING = 400;
const MAX_KEY = 40;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EXIT_TYPES = new Set([
  'page-crash',
  'page-crash-offline-work',
  'page-killed-playing',
  'page-killed-playing-offline-work'
]);

function boundedString(value, max = MAX_STRING) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function boundedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 10) / 10;
}

function normalizeValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return boundedNumber(value);
  if (typeof value === 'string') return boundedString(value);
  return boundedString(JSON.stringify(value));
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const t = boundedNumber(event.t);
  const k = boundedString(event.k, MAX_KEY);
  if (t === null || t < 0 || !k) return null;
  const normalized = { t, k };
  let fields = 0;
  for (const [key, value] of Object.entries(event)) {
    if (key === 't' || key === 'k') continue;
    if (++fields > MAX_FIELDS) break;
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) continue;
    normalized[key] = normalizeValue(value);
  }
  return normalized;
}

// Returns a sanitized session, or null when the body is not a version-1 report.
function normalizeSession(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.v !== REPORT_VERSION) return null;
  const id = boundedString(body.id, 64);
  if (!SESSION_ID.test(id)) return null;
  const startedAt = Number(body.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const events = Array.isArray(body.events)
    ? body.events.slice(-MAX_EVENTS).map(normalizeEvent).filter(Boolean)
    : [];
  return {
    v: REPORT_VERSION,
    id,
    startedAt: Math.round(startedAt),
    build: boundedString(body.build, 40),
    platform: boundedString(body.platform, 16),
    standalone: Boolean(body.standalone),
    userAgent: boundedString(body.userAgent, 300),
    viewport: boundedString(body.viewport, 40),
    deviceMemory: boundedNumber(body.deviceMemory),
    exit: EXIT_TYPES.has(body.exit) ? body.exit : null,
    ended: Boolean(body.ended),
    droppedEvents: Math.max(0, Math.round(Number(body.droppedEvents) || 0)),
    events
  };
}

function summarizeSession(session) {
  const events = Array.isArray(session.events) ? session.events : [];
  const find = key => events.find(event => event.k === key);
  const maxOf = (key, field) => events
    .filter(event => event.k === key)
    .reduce((max, event) => Math.max(max, Number(event[field]) || 0), 0);
  const errors = events.filter(event => event.k === 'error' || event.k === 'rejection').length;
  const last = events[events.length - 1] || null;
  return {
    id: session.id,
    startedAt: new Date(session.startedAt).toISOString(),
    receivedAt: session.receivedAt,
    build: session.build,
    platform: session.platform,
    standalone: session.standalone,
    exit: session.exit,
    ended: session.ended,
    events: events.length,
    errors,
    bootMs: find('boot:ready')?.t ?? null,
    libraryMs: find('library:rendered')?.t ?? null,
    workerMs: find('boot:worker')?.ms ?? null,
    workerReason: find('boot:worker')?.reason ?? null,
    maxLagMs: maxOf('lag', 'ms'),
    maxImageMegapixels: maxOf('mem', 'imgMp'),
    lastEvent: last ? { t: last.t, k: last.k } : null
  };
}

function createClientTelemetryStore({ file, jsonStore, now = () => Date.now(), maxSessions = MAX_SESSIONS, retentionDays = RETENTION_DAYS } = {}) {
  if (!file) throw new TypeError('file is required');
  if (!jsonStore) throw new TypeError('jsonStore is required');

  async function record(userId, body) {
    const session = normalizeSession(body);
    if (!session) return false;
    await jsonStore.update(file, state => {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const existing = sessions.findIndex(item => item.id === session.id && item.userId === userId);
      const previous = existing >= 0 ? sessions[existing] : null;
      const stored = {
        ...session,
        // A crash classification is only known on the next launch, which
        // re-uploads the dead session. Never let a later partial upload of the
        // same session erase it.
        exit: session.exit || previous?.exit || null,
        // Uploads replace the trail; a shorter one is a stale retry.
        events: previous && previous.events.length > session.events.length ? previous.events : session.events,
        userId,
        receivedAt: new Date(now()).toISOString()
      };
      if (existing >= 0) sessions.splice(existing, 1);
      sessions.push(stored);
      // Retention: the newest sessions only, and none older than the window.
      const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
      state.sessions = sessions
        .filter(item => Date.parse(item.receivedAt) >= cutoff)
        .slice(-maxSessions);
    }, { sessions: [] });
    return true;
  }

  async function list() {
    const state = await jsonStore.load(file, { sessions: [] });
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    return sessions.slice().reverse().map(summarizeSession);
  }

  async function get(id) {
    const state = await jsonStore.load(file, { sessions: [] });
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    return sessions.find(item => item.id === id) || null;
  }

  return { record, list, get };
}

// Server half: slow responses and event-loop stalls, kept in memory.
function createServerTrail({ limit = 300, slowMs = 500, now = () => Date.now(), memoryUsage = () => process.memoryUsage() } = {}) {
  const slow = [];
  const stalls = [];
  const memory = [];

  function push(list, item) {
    list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
  }

  function routeLabel(req) {
    const raw = String(req.originalUrl || req.url || '');
    const [pathname, query = ''] = raw.split('?');
    return query ? `${pathname}?${query.slice(0, 80)}` : pathname;
  }

  // Records time to first byte, not total time: audio responses stream for
  // minutes by design, but a client waits only for the headers.
  function middleware(req, res, next) {
    const startedAt = process.hrtime.bigint();
    let firstByteMs = null;
    const writeHead = res.writeHead;
    res.writeHead = function trailWriteHead(...args) {
      if (firstByteMs === null) firstByteMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return writeHead.apply(this, args);
    };
    res.on('finish', () => {
      const ttfb = firstByteMs ?? Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (ttfb < slowMs) return;
      push(slow, {
        at: new Date(now()).toISOString(),
        method: req.method,
        path: routeLabel(req),
        status: res.statusCode,
        ttfbMs: Math.round(ttfb),
        totalMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        admin: req.user?.role === 'admin'
      });
    });
    next();
  }

  function noteStall({ maxMs, p99Ms }) {
    push(stalls, { at: new Date(now()).toISOString(), maxMs, p99Ms });
  }

  function sampleMemory() {
    const usage = memoryUsage();
    push(memory, {
      at: new Date(now()).toISOString(),
      rssMb: Math.round(usage.rss / 1048576),
      heapUsedMb: Math.round(usage.heapUsed / 1048576),
      externalMb: Math.round((usage.external || 0) / 1048576)
    });
  }

  function snapshot() {
    return {
      slowResponses: slow.slice().reverse(),
      eventLoopStalls: stalls.slice().reverse(),
      memory: memory.slice(-60).reverse()
    };
  }

  return { middleware, noteStall, sampleMemory, snapshot };
}

function registerClientTelemetryRoutes(app, { store, trail, requireAdmin }) {
  if (!store) throw new TypeError('store is required');
  if (typeof requireAdmin !== 'function') throw new TypeError('requireAdmin is required');

  app.post('/api/admin/client-telemetry', requireAdmin, async (req, res) => {
    try {
      const accepted = await store.record(String(req.user?.id || 'admin'), req.body);
      if (!accepted) return res.status(400).json({ error: 'Invalid telemetry report' });
      return res.status(204).end();
    } catch (error) {
      console.warn(`Client telemetry report failed: ${error.message}`);
      return res.status(500).json({ error: 'Failed to record telemetry' });
    }
  });

  app.get('/api/admin/client-telemetry', requireAdmin, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({
        sessions: await store.list(),
        server: trail ? trail.snapshot() : null
      });
    } catch (error) {
      console.warn(`Client telemetry listing failed: ${error.message}`);
      return res.status(500).json({ error: 'Failed to load telemetry' });
    }
  });

  app.get('/api/admin/client-telemetry/:id', requireAdmin, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      const session = await store.get(String(req.params.id));
      if (!session) return res.status(404).json({ error: 'Session not found' });
      return res.json(session);
    } catch (error) {
      console.warn(`Client telemetry read failed: ${error.message}`);
      return res.status(500).json({ error: 'Failed to load telemetry' });
    }
  });
}

module.exports = {
  REPORT_VERSION,
  createClientTelemetryStore,
  createServerTrail,
  normalizeSession,
  registerClientTelemetryRoutes,
  summarizeSession
};
