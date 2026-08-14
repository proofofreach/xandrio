'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json']);
const RUNTIME_ROOT_FILES = ['server.js', 'package.json', 'package-lock.json', '.env'];

function runtimeFiles(root) {
  const files = [];
  for (const name of RUNTIME_ROOT_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }

  const libRoot = path.join(root, 'lib');
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  }
  visit(libRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function runtimeDigest(root) {
  const hash = crypto.createHash('sha256');
  for (const file of runtimeFiles(root)) {
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function runtimeSignature(root) {
  return runtimeDigest(root);
}

function runtimeRevision(root) {
  return runtimeDigest(root);
}

function waitForExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finish();
    }, timeoutMs);
  });
}

function createRuntimeSupervisor({
  root,
  spawnChild,
  intervalMs = 1_000,
  stableMs = 1_000,
  stopTimeoutMs = 10_000,
  now = Date.now,
  log = message => console.log(message)
}) {
  if (!root || typeof spawnChild !== 'function') throw new TypeError('root and spawnChild are required');

  let child = null;
  let timer = null;
  let stopped = true;
  let restarting = false;
  let activeSignature = null;
  let pendingSignature = null;
  let pendingSince = 0;
  let operation = Promise.resolve();

  function launch() {
    const revision = runtimeRevision(root);
    activeSignature = runtimeSignature(root);
    pendingSignature = null;
    child = spawnChild({ revision });
    const launched = child;
    launched.once('exit', (code, signal) => {
      if (child === launched) child = null;
      if (!stopped && !restarting) {
        log(`[local-service] server exited (${signal || code}); relaunching`);
        setTimeout(() => {
          if (!stopped && !child) launch();
        }, Math.min(intervalMs, 1_000));
      }
    });
    log(`[local-service] server started (runtime ${revision.slice(0, 12)})`);
  }

  async function restart(signature) {
    restarting = true;
    log('[local-service] backend change detected; restarting server');
    const previous = child;
    child = null;
    await waitForExit(previous, stopTimeoutMs);
    activeSignature = signature;
    if (!stopped) launch();
    restarting = false;
  }

  async function inspect() {
    if (stopped) return;
    const signature = runtimeSignature(root);
    if (signature === activeSignature) {
      pendingSignature = null;
      return;
    }
    if (signature !== pendingSignature) {
      pendingSignature = signature;
      pendingSince = now();
      return;
    }
    if (now() - pendingSince < stableMs) return;
    await restart(signature);
  }

  return {
    start({ schedule = true } = {}) {
      if (!stopped) return;
      stopped = false;
      launch();
      if (schedule) {
        timer = setInterval(() => {
          operation = operation.then(inspect).catch(error => {
            log(`[local-service] reload check failed: ${error.message}`);
          });
        }, intervalMs);
      }
    },
    checkNow() {
      operation = operation.then(inspect);
      return operation;
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await operation;
      const previous = child;
      child = null;
      await waitForExit(previous, stopTimeoutMs);
    }
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function createLaunchAgentPlist({ label, nodePath, root }) {
  const supervisor = path.join(root, 'scripts', 'local-service.js');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(supervisor)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>StandardOutPath</key>
  <string>/tmp/xandrio-server.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/xandrio-server.log</string>
</dict>
</plist>
`;
}

module.exports = {
  createLaunchAgentPlist,
  createRuntimeSupervisor,
  runtimeFiles,
  runtimeRevision,
  runtimeSignature
};
