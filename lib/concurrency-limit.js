'use strict';

const { positiveInteger } = require('./rate-limit');
const { isTtsRoute } = require('./tts-route-patterns');

class ConcurrencyLimitError extends Error {
  constructor(group = 'operation') {
    super(`${group} concurrency limit reached`);
    this.name = 'ConcurrencyLimitError';
    this.code = 'CONCURRENCY_LIMIT';
    this.group = group;
  }
}

class ConcurrencyGate {
  constructor(max = 1, options = {}) {
    this.max = Math.min(1024, positiveInteger(max, 1));
    this.name = options.name || 'operation';
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.max) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  async run(task) {
    const release = this.tryAcquire();
    if (!release) throw new ConcurrencyLimitError(this.name);
    try {
      return await task();
    } finally {
      release();
    }
  }
}

function defaultConcurrencyGroups(limits = {}) {
  const bounded = (name, fallback) => positiveInteger(limits[name], fallback);
  return [
    {
      name: 'auth', max: bounded('auth', 8),
      match: path => path.startsWith('/api/auth/') || path === '/api/integrations/calibre/claim'
    },
    {
      name: 'search', max: bounded('search', 4),
      match: (path, req) => path === '/api/search' && req.method === 'POST'
    },
    {
      name: 'upload', max: bounded('upload', 2),
      match: (path, req) =>
        (path === '/api/upload' || path === '/api/integrations/calibre/import') && req.method === 'POST'
    },
    {
      name: 'metadata', max: bounded('metadata', 2),
      match: (path, req) => path.startsWith('/api/refresh-metadata/') && req.method === 'POST'
    },
    {
      name: 'hls', max: bounded('hls', 16),
      match: path => path.startsWith('/api/audio-hls/')
    },
    {
      name: 'tts', max: bounded('tts', 8),
      match: path => isTtsRoute(path)
    },
    {
      name: 'voice', max: bounded('voice', 1),
      match: (path, req) => path.startsWith('/api/voices/clone') && req.method === 'POST'
    }
  ];
}

// Audio responses that last as long as the listener keeps listening. They hold
// a permit like any other request, but shutdown must not wait for them.
const OPEN_ENDED_STREAM_PATTERN = /^\/api\/(?:audio-(?:continuous|ios|stream|chunked)\/|audio-hls\/)/;

function createConcurrencyLimitMiddleware({ groups = defaultConcurrencyGroups() } = {}) {
  const configured = groups.map(group => ({
    ...group,
    gate: new ConcurrencyGate(group.max, { name: group.name }),
    openEnded: 0
  }));

  function middleware(req, res, next) {
    const pathname = req.path || req.url?.split('?')[0] || '';
    const group = configured.find(candidate => candidate.match(pathname, req));
    if (!group) return next();

    const release = group.gate.tryAcquire();
    if (!release) {
      res.setHeader('Retry-After', '1');
      return res.status(503).json({
        error: 'This operation is busy. Try again shortly.',
        code: 'CONCURRENCY_LIMIT'
      });
    }

    const openEnded = OPEN_ENDED_STREAM_PATTERN.test(pathname);
    if (openEnded) group.openEnded += 1;
    let completed = false;
    const complete = () => {
      if (!completed) {
        completed = true;
        if (openEnded) group.openEnded -= 1;
      }
      release();
    };
    // `close` can occur as soon as a client disconnects while an async route
    // continues provider/OCR work. Releasing there would let disconnect loops
    // bypass the limit. `end` tracks the handler/stream completing even when
    // the socket is already gone. Do not time-release active work: doing so
    // would allow a legitimately long OCR/TTS request to exceed the cap.
    const originalEnd = res.end.bind(res);
    res.end = function concurrencyTrackedEnd(...args) {
      try {
        return originalEnd(...args);
      } finally {
        complete();
      }
    };
    res.once('finish', complete);
    res.once('close', () => {
      if (res.writableFinished) complete();
    });
    return next();
  }

  middleware.groups = configured;
  middleware.isIdle = ({ ignoreOpenEndedStreams = false } = {}) => configured.every(group =>
    group.gate.active - (ignoreOpenEndedStreams ? group.openEnded : 0) <= 0);
  return middleware;
}

module.exports = {
  ConcurrencyGate,
  ConcurrencyLimitError,
  createConcurrencyLimitMiddleware,
  defaultConcurrencyGroups
};
