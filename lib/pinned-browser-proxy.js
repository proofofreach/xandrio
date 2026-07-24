'use strict';

/**
 * Loopback-only HTTPS CONNECT proxy for browser automation.
 *
 * Chromium normally resolves a hostname again after Playwright route handlers
 * have inspected it.  This proxy is the DNS-resolution boundary: it validates
 * the hostname once, then opens the upstream TCP socket to that exact address.
 * The TLS handshake remains inside the CONNECT tunnel, so the browser retains
 * the original hostname for SNI and certificate verification.
 */

const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const { assertPublicTarget } = require('./remote-fetch');

const CONNECT_TIMEOUT_MS = 10_000;

function parseConnectAuthority(value) {
  const authority = String(value || '');
  let hostname;
  let port;

  if (authority.startsWith('[')) {
    const match = authority.match(/^\[([^\]]+)\]:(\d+)$/);
    if (!match) throw new Error('Malformed CONNECT authority');
    [, hostname, port] = match;
  } else {
    const match = authority.match(/^([^:/\s]+):(\d+)$/);
    if (!match) throw new Error('Malformed CONNECT authority');
    [, hostname, port] = match;
  }
  if (port !== '443') throw new Error('Only HTTPS CONNECT requests are allowed');
  if (!hostname || /[\s@]/.test(hostname)) throw new Error('Malformed CONNECT authority');
  return { hostname, port: Number(port) };
}

function targetUrl(authority) {
  const host = net.isIP(authority.hostname) === 6 ? `[${authority.hostname}]` : authority.hostname;
  return new URL(`https://${host}:${authority.port}/`);
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

async function createPinnedBrowserProxy(options = {}) {
  const lookupImpl = options.lookupImpl || dns.lookup;
  const connectImpl = options.connectImpl || net.connect;
  const timeoutMs = Number(options.timeoutMs || CONNECT_TIMEOUT_MS);
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    res.writeHead(405, { Connection: 'close' });
    res.end('HTTPS CONNECT proxy only');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('connect', (request, clientSocket, head) => {
    void (async () => {
      let target;
      try {
        target = await assertPublicTarget(targetUrl(parseConnectAuthority(request.url)), lookupImpl, timeoutMs);
      } catch {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      let upstream;
      try {
        // Deliberately use the vetted numeric address, never the hostname.
        upstream = connectImpl({ host: target.address, port: 443, family: target.family });
      } catch {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Pinned browser proxy connection timed out')));
      upstream.once('error', () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
      });
      upstream.once('connect', () => {
        if (clientSocket.destroyed) { upstream.destroy(); return; }
        upstream.setTimeout(0);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
    })();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Pinned browser proxy did not receive a loopback port');
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  };
}

module.exports = { createPinnedBrowserProxy, parseConnectAuthority };
