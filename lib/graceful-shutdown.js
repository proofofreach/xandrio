'use strict';

// How long a shutdown waits for finite work before it closes connections and
// runs cleanup. Supervisors must allow at least this long before SIGKILL.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createGracefulShutdown({
  getServer = () => null,
  isIdle = () => true,
  onStart = () => {},
  cleanup = async () => {},
  exit = code => process.exit(code),
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  pollMs = 25,
  // Once background work is idle, ordinary requests get this long to finish
  // before remaining connections are closed. Open-ended audio streams never
  // finish on their own, so without it every shutdown with a listener waited
  // for the full deadline while the server refused new requests.
  connectionGraceMs = 1000,
  onError = error => console.error('Graceful shutdown error:', error)
} = {}) {
  let shutdownPromise = null;

  function shutdown(code = 0) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const server = getServer();
      let serverClosed = !server;
      try {
        await onStart();
      } catch (error) {
        onError(error);
      }

      if (server) {
        try {
          server.close(error => {
            if (error) onError(error);
            serverClosed = true;
          });
          server.closeIdleConnections?.();
        } catch (error) {
          onError(error);
          serverClosed = true;
        }
      }

      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS);
      let drained = false;
      let idleSince = null;
      while (Date.now() < deadline) {
        let backgroundIdle = false;
        try {
          backgroundIdle = Boolean(await isIdle());
        } catch (error) {
          onError(error);
        }
        if (backgroundIdle && serverClosed) {
          drained = true;
          break;
        }
        idleSince = backgroundIdle ? (idleSince ?? Date.now()) : null;
        if (idleSince !== null && Date.now() - idleSince >= Math.max(0, Number(connectionGraceMs) || 0)) {
          // All tracked work is done; what remains is idle keep-alive or
          // open-ended streaming connections. Clients reconnect after restart.
          try { server?.closeAllConnections?.(); } catch (error) { onError(error); }
          drained = true;
          break;
        }
        await delay(Math.max(1, Number(pollMs) || 25));
      }

      if (!drained) {
        try { server?.closeAllConnections?.(); } catch (error) { onError(error); }
      }

      try {
        await cleanup({ drained });
      } catch (error) {
        onError(error);
      }
      exit(code);
    })();
    return shutdownPromise;
  }

  return {
    shutdown,
    get isShuttingDown() { return Boolean(shutdownPromise); }
  };
}

module.exports = { createGracefulShutdown, DEFAULT_SHUTDOWN_TIMEOUT_MS };
