'use strict';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createGracefulShutdown({
  getServer = () => null,
  isIdle = () => true,
  cleanup = async () => {},
  exit = code => process.exit(code),
  timeoutMs = 15_000,
  pollMs = 25,
  onError = error => console.error('Graceful shutdown error:', error)
} = {}) {
  let shutdownPromise = null;

  function shutdown(code = 0) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const server = getServer();
      let serverClosed = !server;

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

      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 15_000);
      let drained = false;
      while (Date.now() < deadline) {
        let backgroundIdle = false;
        try {
          backgroundIdle = Boolean(await isIdle());
        } catch (error) {
          onError(error);
        }
        if (serverClosed && backgroundIdle) {
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

module.exports = { createGracefulShutdown };
