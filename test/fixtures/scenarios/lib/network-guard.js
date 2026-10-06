'use strict';

// Preloaded into the real server.js child process via `node --require` so
// that no code path — search providers, cover fetchers, metadata lookups,
// anything reached through `https.request`/`http.request`, `http.get`/
// `https.get`, or global `fetch()` (undici) — can ever leave this machine.
// Every request to a host other than loopback is rewritten, in place, into a
// plain HTTP request against the local provider stub, which answers with
// synthetic fixture data or a 404. This makes "no live provider or network
// calls" a structural property of the harness rather than a matter of
// remembering to configure every provider's env var (several — Gutenberg,
// Internet Archive — have none) or knowing which HTTP client a given call
// site happens to use.
//
// Three distinct entry points must each be guarded independently — none of
// them share an interceptable choke point:
//   - `https.request`/`http.request`: patched directly below.
//   - `https.get`/`http.get`: Node's own implementation calls an internal,
//     unexported `request()` function, NOT `module.exports.request` — so
//     patching `.request` alone never touches `.get()`. It is repatched here
//     to call back into the already-guarded `.request`.
//   - global `fetch()`: implemented by undici, which opens its own sockets
//     and never goes through Node's `http`/`https` modules at all. A guard
//     that only patches `http`/`https` is a false guarantee for any call
//     site using `fetch()` directly — see `lib/search-cover-service.js`'s
//     `writeRemoteCover`, which does exactly that.
//
// KOKORO_TTS_URL / CHATTERBOX_TTS_URL point straight at the stub already, so
// guarding fetch() is not "in case" a provider needs it — it is already
// load-bearing for cover fetching today.

const http = require('node:http');
const https = require('node:https');

const STUB_PORT = Number(process.env.XANDRIO_SCENARIO_STUB_PORT);
if (!Number.isInteger(STUB_PORT) || STUB_PORT <= 0) {
  throw new Error('network-guard: XANDRIO_SCENARIO_STUB_PORT must be set before this module is required');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function stripBrackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

// Normalizes both `request(url, options, cb)` and `request(options, cb)`
// call shapes into one descriptor without invoking anything yet.
function describeCall(args) {
  let urlArg = null;
  let options = {};
  let callback;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    urlArg = args[0] instanceof URL ? args[0] : new URL(args[0]);
    if (typeof args[1] === 'function') callback = args[1];
    else { options = args[1] || {}; callback = args[2]; }
  } else {
    options = args[0] || {};
    callback = args[1];
  }
  const hostname = stripBrackets(urlArg?.hostname || options.hostname || options.host || 'localhost');
  const path = urlArg ? `${urlArg.pathname}${urlArg.search}` : (options.path || '/');
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  return { hostname, path, method, headers, callback, options, protocol: urlArg?.protocol || options._xandrioProtocol };
}

function patch(moduleRef, schemeLabel) {
  const originalRequest = moduleRef.request;
  function guardedRequest(...args) {
    const call = describeCall(args);
    if (LOOPBACK_HOSTS.has(call.hostname)) {
      return originalRequest.apply(moduleRef, args);
    }
    const forwardedHeaders = { ...call.headers };
    delete forwardedHeaders.host;
    delete forwardedHeaders.Host;
    forwardedHeaders.host = `127.0.0.1:${STUB_PORT}`;
    forwardedHeaders['x-scenario-target-host'] = call.hostname;
    forwardedHeaders['x-scenario-target-protocol'] = schemeLabel;
    return http.request({
      hostname: '127.0.0.1',
      port: STUB_PORT,
      path: call.path,
      method: call.method,
      headers: forwardedHeaders,
      signal: call.options.signal
    }, call.callback);
  }
  moduleRef.request = guardedRequest;
  // http.get/https.get do not dispatch through module.exports.request under
  // the hood (Node calls its own internal `request` reference), so patching
  // `.request` alone leaves `.get()` as a live, unguarded egress path. Route
  // it back through the guard explicitly and replicate Node's own
  // request-then-end() behavior.
  moduleRef.get = function guardedGet(...args) {
    const req = guardedRequest.apply(moduleRef, args);
    req.end();
    return req;
  };
}

patch(https, 'https:');
patch(http, 'http:');

// global fetch() (undici) opens its own sockets and is completely invisible
// to the http/https patches above — it must be guarded independently or it
// is a straight, unfiltered line to the live internet regardless of what
// happens to http.request/http.get.
function patchFetch() {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') return;

  function describeFetchCall(input, init) {
    if (input instanceof Request) {
      return {
        url: new URL(input.url),
        method: (init && init.method) || input.method,
        headers: new Headers(input.headers),
        body: init && 'body' in init ? init.body : input.body,
        redirect: (init && init.redirect) || input.redirect,
        signal: (init && init.signal) || input.signal
      };
    }
    return {
      url: new URL(input instanceof URL ? input.href : String(input)),
      method: (init && init.method) || 'GET',
      headers: new Headers((init && init.headers) || {}),
      body: init && init.body,
      redirect: init && init.redirect,
      signal: init && init.signal
    };
  }

  globalThis.fetch = function guardedFetch(input, init) {
    let call;
    try {
      call = describeFetchCall(input, init);
    } catch (error) {
      return Promise.reject(new Error(`network-guard: fetch() called with an unparsable URL: ${error.message}`));
    }
    const hostname = stripBrackets(call.url.hostname);
    if (LOOPBACK_HOSTS.has(hostname)) {
      return originalFetch(input, init);
    }
    // Fail closed: only http/https destinations can be rewritten to the
    // local stub. Anything else (a bad scheme, a malformed target) must
    // reject rather than silently pass through to the real fetch().
    if (call.url.protocol !== 'http:' && call.url.protocol !== 'https:') {
      return Promise.reject(new Error(
        `network-guard: fetch() blocked a non-HTTP(S) destination "${call.url.protocol}//${hostname}" — only loopback or http/https-to-stub egress is permitted`
      ));
    }

    const headers = call.headers;
    headers.delete('host');
    headers.set('host', `127.0.0.1:${STUB_PORT}`);
    headers.set('x-scenario-target-host', hostname);
    headers.set('x-scenario-target-protocol', call.url.protocol);

    const stubUrl = `http://127.0.0.1:${STUB_PORT}${call.url.pathname}${call.url.search}`;
    const guardedInit = {
      method: call.method,
      headers,
      redirect: call.redirect,
      signal: call.signal
    };
    if (call.body !== undefined && call.body !== null) {
      guardedInit.body = call.body;
      guardedInit.duplex = 'half';
    }
    return originalFetch(stubUrl, guardedInit);
  };
}

patchFetch();

// Imported Undici clients and remote-fetch's explicit per-target Agent do not
// use global fetch or its dispatcher. Guard dispatch itself, including custom
// Agent/Client/Pool instances, before a connector can select a remote socket.
const undici = require('undici');
const { kUrl } = require('undici/lib/core/symbols');
const originalAgentDispatch = undici.Agent.prototype.dispatch;
const stubDispatcher = new undici.Agent();
for (const name of ['Agent', 'Client', 'Pool', 'BalancedPool', 'ProxyAgent', 'EnvHttpProxyAgent']) {
  const prototype = undici[name]?.prototype;
  if (!prototype || typeof prototype.dispatch !== 'function') continue;
  const originalDispatch = prototype.dispatch;
  prototype.dispatch = function guardedDispatch(options, handler) {
    const url = new URL(options.path || '/', String(options.origin || this[kUrl]));
    const hostname = stripBrackets(url.hostname);
    if (LOOPBACK_HOSTS.has(hostname) && ['http:', 'https:'].includes(url.protocol)) {
      return originalDispatch.call(this, options, handler);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`network-guard: Undici blocked a non-HTTP(S) destination ${url.protocol}`);
    }
    const headers = new Headers();
    if (Array.isArray(options.headers)) {
      for (let i = 0; i < options.headers.length; i += 2) headers.append(String(options.headers[i]), String(options.headers[i + 1]));
    } else {
      for (const [key, value] of Object.entries(options.headers || {})) headers.append(key, String(value));
    }
    headers.delete('host');
    headers.set('host', `127.0.0.1:${STUB_PORT}`);
    headers.set('x-scenario-target-host', hostname);
    headers.set('x-scenario-target-protocol', url.protocol);
    return originalAgentDispatch.call(stubDispatcher, {
      ...options,
      origin: `http://127.0.0.1:${STUB_PORT}`,
      path: `${url.pathname}${url.search}`,
      headers: [...headers].flat(),
      // Never retain a target-specific connector/authority when forwarding.
      servername: undefined
    }, handler);
  };
}

// Share the guarded package dispatcher with built-in global fetch too, so
// redirects returned by the stub pass through the same origin guard.
undici.setGlobalDispatcher(new undici.Agent());

// DNS must not reach a real resolver. Supply a public synthetic address so
// the unchanged production assertPublicTarget still executes its SSRF checks;
// restricted IP literals are rejected by the product before transport.
const dns = require('node:dns');
const originalLookup = dns.lookup;
const originalPromiseLookup = dns.promises.lookup;
function syntheticRecords(options) {
  const family = options === 6 || options?.family === 6 ? 6 : 4;
  const address = family === 6 ? '2606:4700::1111' : '93.184.216.34';
  return options?.all ? [{ address, family }] : { address, family };
}
dns.lookup = function guardedLookup(hostname, options, callback) {
  if (LOOPBACK_HOSTS.has(stripBrackets(hostname))) return originalLookup.apply(this, arguments);
  if (typeof options === 'function') { callback = options; options = {}; }
  const result = syntheticRecords(options);
  queueMicrotask(() => options?.all ? callback(null, result) : callback(null, result.address, result.family));
};
dns.promises.lookup = function guardedPromiseLookup(hostname, options) {
  if (LOOPBACK_HOSTS.has(stripBrackets(hostname))) return originalPromiseLookup.call(this, hostname, options);
  return Promise.resolve(syntheticRecords(options));
};

// Last barrier for unrecognised transports, custom dispatchers and proxy
// tunnels. TCP may connect only to literal loopback or localhost. Preserve
// Unix sockets used by local tooling. This is only a scenario child preload.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function loopbackOnlyConnect(...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const isOptions = options && typeof options === 'object';
  const unix = typeof options === 'string' && !/^\d+$/.test(options) || isOptions && options.path;
  const host = isOptions ? options.host || options.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!unix && !LOOPBACK_HOSTS.has(stripBrackets(host))) {
    throw new Error(`network-guard: blocked non-loopback socket to ${host}`);
  }
  if (!unix && isOptions && stripBrackets(host) === 'localhost') {
    const lookup = options.lookup || originalLookup;
    options.lookup = function loopbackLookup(name, lookupOptions, callback) {
      lookup(name, lookupOptions, (error, addresses, family) => {
        const resolved = Array.isArray(addresses) ? addresses.map(item => item.address) : [addresses];
        if (!error && resolved.some(address => !LOOPBACK_HOSTS.has(stripBrackets(address)))) {
          return callback(new Error('network-guard: blocked a localhost lookup resolving outside loopback'));
        }
        callback(error, addresses, family);
      });
    };
  }
  return originalConnect.apply(this, args);
};
