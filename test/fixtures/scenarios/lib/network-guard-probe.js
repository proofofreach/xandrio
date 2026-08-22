'use strict';

// Child process body for verify-network-guard.js. Runs with
// `--require network-guard.js` already applied (via NODE_OPTIONS, exactly as
// the real dataset servers run it) and XANDRIO_SCENARIO_STUB_PORT pointed at
// the regression's own loopback catcher (not the real provider stub) so each
// probe's response can be inspected directly. Prints one JSON line per probe
// to stdout; never touches the real network if the guard is doing its job —
// every target below is either a reserved, non-routable test address
// (RFC 5737 TEST-NET-1) or a real-looking public hostname that must never
// actually be dialed.
//
// Every probe races its request against an AbortController tied to
// PROBE_TIMEOUT_MS. Aborting (not just racing with a bare setTimeout)
// matters: if the guard has a hole and a probe's request genuinely leaves
// the machine, that socket must be torn down on timeout, or the still-open
// handle keeps this child process alive long after every probe has already
// reported its result — hanging the whole regression instead of failing it.

const http = require('node:http');
const https = require('node:https');

const PROBE_TIMEOUT_MS = 4000;

function record(name, promise) {
  return promise.then(
    result => ({ name, ok: true, ...result }),
    error => ({ name, ok: false, error: String(error && error.message || error) })
  );
}

function withTimeout(name, run) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${name} timed out after ${PROBE_TIMEOUT_MS}ms — this means the request left the machine instead of being caught by the guard`)),
    PROBE_TIMEOUT_MS
  );
  return run(controller.signal).finally(() => clearTimeout(timer));
}

function probeHttpsRequest() {
  return withTimeout('https.request', signal => new Promise((resolve, reject) => {
    const req = https.request('https://198.51.100.7/probe/https-request', { signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.end();
  }));
}

function probeHttpGet() {
  return withTimeout('http.get', signal => new Promise((resolve, reject) => {
    const req = http.get('http://gutendex.example.net/probe/http-get', { signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
  }));
}

function probeHttpsGet() {
  return withTimeout('https.get', signal => new Promise((resolve, reject) => {
    const req = https.get('https://203.0.113.9/probe/https-get', { signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
  }));
}

function probeFetch() {
  return withTimeout('fetch', async signal => {
    const response = await fetch('https://gutendex.com/probe/fetch', { signal });
    const body = await response.json();
    return { status: response.status, body };
  });
}

function probeFetchPost() {
  return withTimeout('fetch (POST with body)', async signal => {
    const response = await fetch('https://archive.org/probe/fetch-post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marker: 'fetch-post-body' }),
      signal
    });
    const body = await response.json();
    return { status: response.status, body };
  });
}

function probeFetchNonHttpRejected() {
  return withTimeout('fetch (non-http(s) scheme)', async signal => {
    try {
      await fetch('ws://gutendex.com/probe/should-reject', { signal });
      throw new Error('expected a non-HTTP(S) fetch() destination to reject, but it resolved');
    } catch (error) {
      // Rejecting is the correct, fail-closed behavior for this probe.
      return { rejected: true, message: String(error && error.message || error) };
    }
  });
}

async function main() {
  const results = await Promise.all([
    record('https.request', probeHttpsRequest()),
    record('http.get', probeHttpGet()),
    record('https.get', probeHttpsGet()),
    record('fetch', probeFetch()),
    record('fetch-post-body', probeFetchPost()),
    record('fetch-non-http-scheme', probeFetchNonHttpRejected())
  ]);
  process.stdout.write(`${JSON.stringify(results)}\n`);
  // Force exit even if the guard failed to guard something: a real,
  // still-open socket to a live host must not be able to keep this process
  // (and the parent regression waiting on it) alive.
  process.exit(0);
}

main().catch(error => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
