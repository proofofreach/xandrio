'use strict';

// Boots the whole scenario harness: a provider-network stub, one TTS-engine
// stub pair per dataset, five real `node server.js` child processes (one per
// dataset — 'cold', 'empty', 'full', 'degraded', 'login' — each with its own
// DATA_DIR/CACHE_DIR so their states can't bleed into each other), and the
// public proxy-router in front of all of them. Shared by scripts/scenario-server.js
// (long-running dev server) and scripts/scenario-shots.js (boot, shoot, tear down).

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const { provisionDataset } = require('./provision');
const { createTtsEngineStub, createProviderNetworkStub } = require('./provider-stub');
const { createProxyRouter } = require('./proxy-router');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const NETWORK_GUARD_PATH = path.join(__dirname, 'network-guard.js');

const DATASETS = ['cold', 'empty', 'full', 'degraded', 'login'];

async function loadContent(name) {
  return JSON.parse(await fs.readFile(path.join(__dirname, '..', 'content', name), 'utf8'));
}

function waitForHealth(origin, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(`${origin}/health`);
        if (response.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() >= deadline) return reject(new Error(`Scenario server at ${origin} never became healthy`));
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function startDatasetServer({ dataset, dataDir, cacheDir, kokoroPort, chatterboxPort, guardPort, log }) {
  const port = await new Promise((resolve, reject) => {
    const { createServer } = require('node:net');
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: assigned } = probe.address();
      probe.close(() => resolve(assigned));
    });
  });

  const env = buildDatasetServerEnvironment({
    port,
    dataDir,
    cacheDir,
    kokoroPort,
    chatterboxPort,
    guardPort
  });

  const logPath = path.join(dataDir, '..', `${dataset}.server.log`);
  const logFd = await fs.open(logPath, 'w');
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', logFd.fd, logFd.fd]
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) log(`[${dataset}] server exited early (code=${code} signal=${signal}); see ${logPath}`);
  });

  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(origin);
  } catch (error) {
    const tail = await fs.readFile(logPath, 'utf8').catch(() => '');
    throw new Error(`${error.message}\n--- ${dataset}.server.log tail ---\n${tail.slice(-4000)}`);
  }
  await logFd.close();
  return { dataset, port, child, logPath };
}

// Do not inherit process.env here. A scenario dataset is a credential-free,
// deterministic harness, so the child gets only the runtime values it needs.
// PATH is the one exception: lib/audio-chunk-service.js shells out to a
// real `ffmpeg` binary for chunk mastering (silence trim, normalization,
// mp3 encoding) — with no PATH at all, `spawn('ffmpeg', ...)` fails
// `ENOENT` before it ever runs, which the client sees as a generation
// "error" status. That's not a credential and reveals nothing about the
// operator; it's the same directory search path any real deployment's
// shell already provides to `node server.js`.
function buildDatasetServerEnvironment({ port, dataDir, cacheDir, kokoroPort, chatterboxPort, guardPort }) {
  return {
    PORT: String(port),
    HOST: '127.0.0.1',
    PATH: process.env.PATH || '',
    DATA_DIR: dataDir,
    CACHE_DIR: cacheDir,
    NODE_OPTIONS: `--require ${NETWORK_GUARD_PATH}`,
    XANDRIO_SCENARIO_STUB_PORT: String(guardPort),
    KOKORO_TTS_URL: `http://127.0.0.1:${kokoroPort}`,
    CHATTERBOX_TTS_URL: `http://127.0.0.1:${chatterboxPort}`,
    KOKORO_AUTO_START: 'false',
    CHATTERBOX_AUTO_START: 'false',
    // Edge TTS has no configurable endpoint, so it is excluded entirely
    // rather than stubbed — the harness never needs to reach a real host.
    XANDRIO_VOICE_PROVIDERS: 'kokoro,chatterbox',
    XANDRIO_DEFAULT_VOICE: 'kokoro:am_onyx',
    XANDRIO_PREGENERATE_ON_IMPORT: 'false',
    // lib/remote-fetch.js's SSRF guard (assertPublicTarget) rejects any
    // non-public-HTTPS URL before a request is even attempted, so these
    // cannot point at loopback directly — they use real, resolvable public
    // hostnames (standardebooks.org's real default; example.com, an IANA
    // reserved domain guaranteed never to serve real content, for the
    // custom feed) and rely on the network guard's *hostname*-based
    // redirect, exactly like Gutenberg/Internet Archive. DNS still resolves
    // for these hosts; no application data ever reaches them — the network
    // guard rewrites the connection itself before any request leaves this
    // process (see lib/network-guard.js).
    OPDS_FEED_URL: 'https://example.com/opds-feed',
    OPDS_LABEL: 'Scenario OPDS',
    XANDRIO_TOKEN: '',
    ANNAS_SECRET_KEY: '',
    XANDRIO_TRUST_PROXY: 'false'
  };
}

async function startScenarioEnvironment({
  proxyPort = Number(process.env.SCENARIO_PORT || 8399),
  runtimeDir,
  datasets = DATASETS,
  defaultDataset,
  log = () => {}
} = {}) {
  const selectedDatasets = [...new Set(datasets)];
  if (selectedDatasets.length === 0 || selectedDatasets.some(dataset => !DATASETS.includes(dataset))) {
    throw new TypeError(`Scenario datasets must be a non-empty subset of: ${DATASETS.join(', ')}`);
  }
  const selectedDefaultDataset = defaultDataset || selectedDatasets[0];
  if (!selectedDatasets.includes(selectedDefaultDataset)) {
    throw new TypeError('Scenario defaultDataset must be one of the selected datasets');
  }
  const workDir = runtimeDir || await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-scenario-'));
  await fs.mkdir(workDir, { recursive: true });

  const searchResults = await loadContent('search-results.json');
  const providerStub = createProviderNetworkStub(searchResults);
  const guardPort = await providerStub.listen(0);
  log(`provider network stub on 127.0.0.1:${guardPort}`);

  const engineStubs = {};
  const datasetServers = {};
  const datasetPorts = {};

  for (const dataset of selectedDatasets) {
    const datasetDir = path.join(workDir, dataset);
    const dataDir = path.join(datasetDir, 'data');
    const cacheDir = path.join(datasetDir, 'cache');
    await provisionDataset({ dataDir, cacheDir, dataset });

    const kokoro = createTtsEngineStub('kokoro');
    const chatterbox = createTtsEngineStub('chatterbox', { failing: dataset === 'degraded' });
    const kokoroPort = await kokoro.listen(0);
    const chatterboxPort = await chatterbox.listen(0);
    engineStubs[dataset] = { kokoro, chatterbox };

    log(`provisioning "${dataset}" dataset, booting real server.js…`);
    const started = await startDatasetServer({
      dataset, dataDir, cacheDir, kokoroPort, chatterboxPort, guardPort, log
    });
    datasetServers[dataset] = started;
    datasetPorts[dataset] = started.port;
    log(`"${dataset}" dataset ready on 127.0.0.1:${started.port}`);
  }

  const router = createProxyRouter({ datasetPorts, defaultDataset: selectedDefaultDataset });
  const listenedPort = await router.listen(proxyPort);
  log(`scenario proxy listening on http://127.0.0.1:${listenedPort}`);

  return {
    origin: `http://127.0.0.1:${listenedPort}`,
    workDir,
    datasetPorts,
    async close({ keepRuntimeDir = false } = {}) {
      await router.close();
      for (const { child } of Object.values(datasetServers)) {
        child.kill('SIGTERM');
      }
      await Promise.all(Object.values(engineStubs).flatMap(({ kokoro, chatterbox }) => [kokoro.close(), chatterbox.close()]));
      await providerStub.close();
      if (!keepRuntimeDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

module.exports = { startScenarioEnvironment, buildDatasetServerEnvironment, DATASETS };
