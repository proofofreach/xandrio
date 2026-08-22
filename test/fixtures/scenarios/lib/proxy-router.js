'use strict';

// The single public port scenario-shots.js (or a human with curl) talks to.
// Reads an `X-Xandrio-Scenario: <view>:<state>` header to decide which
// dataset child server to forward to, and — for the view's one "primary"
// data endpoint (see lib/matrix.js) — whether to delay or fail the response
// so a loading/skeleton/error frame is reliably capturable against a real
// server that would otherwise answer from local disk in a few milliseconds.
// Every other request (static assets, audio bytes, sw.js, all other API
// calls) passes straight through untouched.

const http = require('node:http');
const { MATRIX, PRIMARY_ENDPOINT } = require('./matrix');

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
}

function resolveScenario(headerValue) {
  if (!headerValue) return null;
  const [view, state] = String(headerValue).split(':');
  const definition = MATRIX[view]?.[state];
  if (!definition || !definition.applicable) return null;
  return { view, state, ...definition };
}

function proxyTo(port, req, res) {
  // Deliberately keep the original `Host` header (the public proxy address)
  // instead of rewriting it to the backend's port. lib/csrf.js's same-origin
  // check compares the browser's `Origin` header against the request's own
  // `Host` header — rewriting Host to the backend port would make every
  // state-changing request look cross-origin and get 403'd, even though the
  // TCP connection below (hostname/port) already targets the right backend
  // regardless of what the Host header says.
  const upstream = http.request({
    hostname: '127.0.0.1',
    port,
    path: req.url,
    method: req.method,
    headers: req.headers
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', error => {
    if (!res.headersSent) sendJson(res, 502, { error: `Scenario proxy upstream error: ${error.message}` });
    else res.destroy();
  });
  req.pipe(upstream);
}

function createProxyRouter({ datasetPorts, defaultDataset = 'full' }) {
  const server = http.createServer((req, res) => {
    const scenario = resolveScenario(req.headers['x-xandrio-scenario']);
    const dataset = scenario?.dataset || defaultDataset;
    const port = datasetPorts[dataset] || datasetPorts[defaultDataset];
    if (!port) return sendJson(res, 500, { error: `Scenario proxy has no server for dataset "${dataset}"` });

    const endpoint = scenario && PRIMARY_ENDPOINT[scenario.view];
    const isPrimaryRequest = endpoint && req.method === endpoint.method && endpoint.pattern.test(req.url);

    if (isPrimaryRequest && scenario.errorStatus) {
      return sendJson(res, scenario.errorStatus, {
        error: 'Scenario-injected failure',
        code: 'SCENARIO_INJECTED_ERROR'
      });
    }
    if (isPrimaryRequest && scenario.delayMs) {
      return setTimeout(() => proxyTo(port, req, res), scenario.delayMs);
    }
    proxyTo(port, req, res);
  });

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

module.exports = { createProxyRouter, resolveScenario };
