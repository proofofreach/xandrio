// Deep device telemetry for administrator accounts.
//
// Records a bounded trail of what this page did: boot phase timings, slow or
// large resource loads, main-thread stalls, decoded image pixels, DOM size,
// offline-audio work, routes, visibility and script errors. The trail lives in
// localStorage while the page runs, so when iOS kills the content process
// (out of memory, "A problem repeatedly occurred") the next launch still has
// it, classifies the exit and uploads it.
//
// Nothing is persisted or sent until the page knows the account is an
// administrator. That fact is remembered, so the next launch records from its
// very first moment, before the auth check returns.

import { classifyPreviousExit } from './page-exit-monitor.mjs';

const REPORT_VERSION = 1;
const SESSION_KEY = 'xandrio_admin_telemetry';
const PENDING_KEY = 'xandrio_admin_telemetry_pending';
const ENABLED_KEY = 'xandrio_admin_telemetry_enabled';
const PAGE_SESSION_KEY = 'xandrio_page_session';
const MAX_EVENTS = 500;
const MAX_PENDING = 3;
// fetch keepalive bodies are capped at 64 KiB in total.
const MAX_BODY_BYTES = 60000;
const PERSIST_DELAY_MS = 1000;
const UPLOAD_INTERVAL_MS = 60000;
const LAG_INTERVAL_MS = 500;
const LAG_REPORT_MS = 150;
const MEMORY_SAMPLE_MS = 5000;
const MEMORY_REPORT_EVERY_MS = 60000;
const MAX_CONSOLE_EVENTS = 80;

function randomId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  } catch {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function short(value, max = 200) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

// Path plus a short query: enough to tell the request apart, never a full
// signed URL or a long id list.
export function resourceLabel(url, origin = globalThis.location?.origin) {
  try {
    const parsed = new URL(url, origin);
    const base = parsed.origin === origin ? parsed.pathname : `${parsed.host}${parsed.pathname}`;
    const query = parsed.search ? parsed.search.slice(0, 40) : '';
    return short(`${base}${query}`, 140);
  } catch {
    return short(url, 140);
  }
}

export function createAdminTelemetry({
  storage = globalThis.localStorage,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  wallNow = () => Date.now(),
  send = null,
  build = '',
  platform = 'other',
  standalone = false,
  userAgent = globalThis.navigator?.userAgent || '',
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis)
} = {}) {
  const read = key => {
    try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; }
  };
  const write = (key, value) => {
    try {
      if (value == null) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };

  // Admin state remembered from the previous launch: null means unknown.
  let enabled = (() => {
    try { return storage?.getItem(ENABLED_KEY) === '1' ? true : null; } catch { return null; }
  })();
  const session = {
    v: REPORT_VERSION,
    id: randomId(),
    startedAt: wallNow(),
    build: short(build, 40),
    platform: short(platform, 16),
    standalone: Boolean(standalone),
    userAgent: short(userAgent, 300),
    viewport: short(`${globalThis.innerWidth || 0}x${globalThis.innerHeight || 0}@${globalThis.devicePixelRatio || 1}`, 40),
    deviceMemory: Number(globalThis.navigator?.deviceMemory) || null,
    exit: null,
    ended: false,
    droppedEvents: 0,
    events: []
  };
  let persistTimer = null;
  let uploadedEvents = 0;

  // The previous session is read before this one overwrites the slot. Its exit
  // class comes from the page-exit heartbeat, which is also still unread.
  const previous = read(SESSION_KEY);
  const previousExit = classifyPreviousExit(read(PAGE_SESSION_KEY), wallNow());
  if (previous && previous.id && Array.isArray(previous.events)) {
    if (previousExit && !previous.ended) previous.exit = previousExit;
    const pending = (read(PENDING_KEY) || []).filter(item => item?.id !== previous.id);
    pending.push(previous);
    write(PENDING_KEY, pending.slice(-MAX_PENDING));
  }

  function mark(k, fields = {}) {
    if (enabled === false) return;
    const event = { t: Math.round(now() * 10) / 10, k: short(k, 40) };
    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined) continue;
      event[key] = typeof value === 'string' ? short(value, 300) : value;
    }
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      // Keep the boot phases at the head: they are what a slow start is read from.
      const head = session.events.slice(0, 40);
      const tail = session.events.slice(-(MAX_EVENTS - 140));
      session.droppedEvents += session.events.length - head.length - tail.length;
      session.events = head.concat(tail);
    }
    schedulePersist(fields?.urgent === true);
  }

  function persistNow() {
    if (persistTimer !== null) {
      clearTimeoutFn?.(persistTimer);
      persistTimer = null;
    }
    // Unknown admin state: hold the trail in memory until the auth check.
    if (enabled !== true) return;
    if (!write(SESSION_KEY, session)) {
      // Storage full: keep the newest half so the last moments survive.
      session.droppedEvents += Math.floor(session.events.length / 2);
      session.events = session.events.slice(Math.floor(session.events.length / 2));
      write(SESSION_KEY, session);
    }
  }

  function schedulePersist(urgent = false) {
    if (enabled !== true) return;
    if (urgent) return persistNow();
    if (persistTimer !== null) return;
    persistTimer = setTimeoutFn?.(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DELAY_MS) ?? null;
  }

  function fitBody(report) {
    let body = JSON.stringify(report);
    if (body.length <= MAX_BODY_BYTES) return body;
    const copy = { ...report, events: report.events.slice() };
    while (copy.events.length > 20 && body.length > MAX_BODY_BYTES) {
      const drop = Math.max(10, Math.floor(copy.events.length * 0.1));
      copy.events.splice(40, drop);
      copy.droppedEvents = (copy.droppedEvents || 0) + drop;
      body = JSON.stringify(copy);
    }
    return body;
  }

  async function upload(report) {
    if (typeof send !== 'function') return false;
    try {
      const result = await send(fitBody(report));
      if (result === 'forbidden') {
        disable();
        return false;
      }
      return result === true;
    } catch {
      return false;
    }
  }

  async function uploadPending() {
    const pending = read(PENDING_KEY) || [];
    if (!pending.length) return;
    const remaining = [];
    for (const item of pending) {
      if (!await upload({ ...item, v: REPORT_VERSION })) remaining.push(item);
    }
    write(PENDING_KEY, remaining.length ? remaining : null);
  }

  function flush(reason = '') {
    if (enabled !== true) return Promise.resolve(false);
    if (reason) mark('flush', { reason });
    persistNow();
    if (session.events.length === uploadedEvents && !session.ended) return Promise.resolve(true);
    const count = session.events.length;
    return upload(session).then(ok => {
      if (ok) uploadedEvents = Math.max(uploadedEvents, count);
      return ok;
    });
  }

  function enable() {
    if (enabled === true) return;
    enabled = true;
    // Raw, not JSON: the launch-time read compares the plain string.
    try { storage?.setItem(ENABLED_KEY, '1'); } catch {}
    mark('telemetry:enabled');
    persistNow();
    void uploadPending();
  }

  // Not an administrator: forget everything this page recorded.
  function disable() {
    enabled = false;
    session.events = [];
    write(ENABLED_KEY, null);
    write(SESSION_KEY, null);
    write(PENDING_KEY, null);
  }

  function endSession() {
    session.ended = true;
    mark('pagehide', { urgent: true });
  }

  function resumeSession() {
    session.ended = false;
    mark('pageshow');
  }

  return {
    mark,
    flush,
    enable,
    disable,
    endSession,
    resumeSession,
    persistNow,
    uploadPending,
    isEnabled: () => enabled === true,
    session: () => session,
    previousExit: () => previousExit
  };
}

// Browser collectors. Each one is cheap and bounded, and each reports only
// what is unusual: slow, large, stalled or failed.
export function installTelemetryCollectors(telemetry, {
  target = globalThis,
  doc = globalThis.document,
  perf = globalThis.performance,
  intervalFn = globalThis.setInterval?.bind(globalThis),
  now = () => globalThis.performance?.now?.() ?? Date.now()
} = {}) {
  if (!telemetry || !target || !doc) return;

  telemetry.mark('boot:script', {
    nav: perf?.getEntriesByType?.('navigation')?.[0]?.type || '',
    controlled: Boolean(globalThis.navigator?.serviceWorker?.controller),
    controller: resourceLabel(globalThis.navigator?.serviceWorker?.controller?.scriptURL || ''),
    online: globalThis.navigator?.onLine !== false,
    vis: doc.visibilityState,
    hash: short(target.location?.hash, 80)
  });

  // Errors and rejections. Resource errors (img, script) do not bubble, so
  // capture them on the way down.
  target.addEventListener?.('error', event => {
    const element = event?.target;
    if (element && element !== target && element.tagName) {
      telemetry.mark('res-error', {
        tag: short(element.tagName, 10),
        src: resourceLabel(element.currentSrc || element.src || element.href || '')
      });
      return;
    }
    telemetry.mark('error', {
      msg: short(event?.message || event?.error?.message, 300),
      src: resourceLabel(event?.filename || ''),
      line: Number(event?.lineno) || 0,
      col: Number(event?.colno) || 0,
      stack: short(event?.error?.stack, 400),
      urgent: true
    });
  }, true);
  target.addEventListener?.('unhandledrejection', event => {
    const reason = event?.reason;
    telemetry.mark('rejection', {
      msg: short(reason?.message || reason, 300),
      name: short(reason?.name, 40),
      stack: short(reason?.stack, 400),
      urgent: true
    });
  });

  // Console errors and warnings carry the app's own failure explanations.
  let consoleCount = 0;
  for (const level of ['error', 'warn']) {
    const original = globalThis.console?.[level];
    if (typeof original !== 'function') continue;
    globalThis.console[level] = function telemetryConsole(...args) {
      if (consoleCount < MAX_CONSOLE_EVENTS) {
        consoleCount++;
        telemetry.mark(`console:${level}`, {
          msg: short(args.map(arg => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'object' ? (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })() : String(arg))).join(' '), 300)
        });
      }
      return original.apply(this, args);
    };
  }

  // Page lifecycle and routing.
  doc.addEventListener?.('visibilitychange', () => {
    telemetry.mark('vis', { s: doc.visibilityState, urgent: true });
    if (doc.visibilityState === 'hidden') void telemetry.flush('hidden');
  });
  target.addEventListener?.('pagehide', () => {
    telemetry.endSession();
    void telemetry.flush();
  });
  target.addEventListener?.('pageshow', event => {
    if (event?.persisted) telemetry.resumeSession();
  });
  target.addEventListener?.('hashchange', () => telemetry.mark('route', { hash: short(target.location?.hash, 80), urgent: true }));
  target.addEventListener?.('online', () => telemetry.mark('net', { online: true }));
  target.addEventListener?.('offline', () => telemetry.mark('net', { online: false }));
  target.addEventListener?.('memorywarning', () => telemetry.mark('memorywarning', { urgent: true }));

  // Slow or large resources: API calls, covers, audio, modules.
  const Observer = globalThis.PerformanceObserver;
  const supported = Observer?.supportedEntryTypes || [];
  let resources = 0;
  let resourceKb = 0;
  if (Observer && supported.includes('resource')) {
    try {
      new Observer(list => {
        for (const entry of list.getEntries()) {
          resources++;
          const kb = Math.round((entry.transferSize || entry.encodedBodySize || 0) / 1024);
          resourceKb += kb;
          const decodedKb = Math.round((entry.decodedBodySize || 0) / 1024);
          const label = resourceLabel(entry.name);
          const api = label.startsWith('/api/');
          if (entry.duration >= (api ? 300 : 800) || decodedKb >= 250) {
            telemetry.mark('res', {
              p: label,
              ms: Math.round(entry.duration),
              ttfb: Math.round(Math.max(0, (entry.responseStart || 0) - (entry.requestStart || entry.startTime || 0))),
              kb,
              dkb: decodedKb,
              at: Math.round(entry.startTime),
              init: short(entry.initiatorType, 12)
            });
          }
        }
      }).observe({ type: 'resource', buffered: true });
    } catch {}
  }
  if (Observer && supported.includes('longtask')) {
    try {
      new Observer(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 200) telemetry.mark('longtask', { ms: Math.round(entry.duration), at: Math.round(entry.startTime) });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
  }

  // Main-thread lag, for engines without long-task timing (Safari). A timer
  // that fires late measures how long the thread was busy.
  let expected = now() + LAG_INTERVAL_MS;
  intervalFn?.(() => {
    const current = now();
    const lag = current - expected;
    expected = current + LAG_INTERVAL_MS;
    // A hidden page's timers are throttled; that is not a stall.
    if (lag >= LAG_REPORT_MS && doc.visibilityState !== 'hidden') {
      telemetry.mark('lag', { ms: Math.round(lag) });
    }
  }, LAG_INTERVAL_MS);

  // Memory proxies. iOS exposes no heap size, but decoded images dominate a
  // page's memory there: a 1600x2400 cover holds about 15 MB once decoded.
  let lastMemory = null;
  let lastMemoryAt = -Infinity;
  const sampleMemory = () => {
    let imgMp = 0;
    let imgs = 0;
    let largest = 0;
    try {
      for (const image of doc.images || []) {
        if (!image.complete || !image.naturalWidth) continue;
        imgs++;
        const mp = (image.naturalWidth * image.naturalHeight) / 1e6;
        imgMp += mp;
        largest = Math.max(largest, mp);
      }
    } catch {}
    const nodes = doc.getElementsByTagName?.('*')?.length || 0;
    const heap = perf?.memory?.usedJSHeapSize ? Math.round(perf.memory.usedJSHeapSize / 1048576) : null;
    const sample = {
      imgs,
      imgMp: Math.round(imgMp * 10) / 10,
      maxImgMp: Math.round(largest * 10) / 10,
      nodes,
      heapMb: heap
    };
    const current = now();
    const changed = !lastMemory
      || Math.abs(sample.imgMp - lastMemory.imgMp) >= Math.max(2, lastMemory.imgMp * 0.15)
      || Math.abs(sample.nodes - lastMemory.nodes) >= Math.max(300, lastMemory.nodes * 0.2)
      || (heap && lastMemory.heapMb && Math.abs(heap - lastMemory.heapMb) >= 20);
    if (changed || current - lastMemoryAt >= MEMORY_REPORT_EVERY_MS) {
      telemetry.mark('mem', { ...sample, res: resources, resKb: resourceKb });
      lastMemory = sample;
      lastMemoryAt = current;
    }
  };
  intervalFn?.(sampleMemory, MEMORY_SAMPLE_MS);

  // Periodic upload so a long session that later dies is mostly on the server.
  intervalFn?.(() => {
    if (doc.visibilityState !== 'hidden') void telemetry.flush();
  }, UPLOAD_INTERVAL_MS);

  try {
    void globalThis.navigator?.storage?.estimate?.().then(estimate => {
      telemetry.mark('storage', {
        usageMb: Math.round((estimate?.usage || 0) / 1048576),
        quotaMb: Math.round((estimate?.quota || 0) / 1048576)
      });
    }).catch(() => {});
  } catch {}
}

export function sendAdminTelemetry(body, { fetch = globalThis.fetch, apiBase = '', headers = {} } = {}) {
  if (typeof fetch !== 'function') return Promise.resolve(false);
  return fetch(`${apiBase}/api/admin/client-telemetry`, {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  }).then(response => {
    // Not an administrator after all: stop recording on this device.
    if (response.status === 403 || response.status === 401) return 'forbidden';
    return response.ok;
  }).catch(() => false);
}

// The page's one telemetry instance, so any module can record without
// plumbing. Calls before installation, or for non-administrators, do nothing.
let activeTelemetry = null;

export function setActiveTelemetry(telemetry) {
  activeTelemetry = telemetry || null;
}

export function telemetryMark(k, fields) {
  try { activeTelemetry?.mark(k, fields); } catch {}
}

export function telemetryNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
