const path = require('path');
const fsSync = require('fs');
const { execFileSync, spawn } = require('child_process');
const { resolveChatterboxImplementation } = require('./chatterbox-tuning');

/**
 * Owns the local narration-engine lifecycle. Callers select an engine through
 * start/stop/health/processHint; PID adoption, duplicate cleanup, child
 * supervision, restart policy, and probing stay behind this seam.
 *
 * The process, timer, and health dependencies are injectable so its lifecycle
 * behavior can be tested without starting long-lived local servers.
 */
function createNarrationRuntime(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fs = options.fs || fsSync;
  const processes = options.process || {};
  const timers = options.timers || { setTimeout, clearTimeout };
  const clock = options.clock || Date;
  const logger = options.logger || console;
  const output = options.output || { stdout: process.stdout, stderr: process.stderr };
  const healthClient = options.healthClient || {};
  const implementation = options.chatterboxImplementation || resolveChatterboxImplementation({
    platform,
    engine: env.CHATTERBOX_ENGINE
  });
  const chatterboxUsesV3 = implementation === 'v3';
  const chatterboxUsesV3Mlx = implementation === 'v3-mlx';
  const chatterboxUsesPytorch = implementation === 'pytorch' || chatterboxUsesV3;
  const kokoroServerPath = options.kokoroServerPath || path.join(rootDir, 'm4-server', 'kokoro-server.py');
  const kokoroVenvPython = options.kokoroVenvPython || path.join(rootDir, 'kokoro-venv', 'bin', 'python');
  const chatterboxServerPath = options.chatterboxServerPath || path.join(
    rootDir,
    'm4-server',
    chatterboxUsesV3
      ? 'chatterbox-v3-server.py'
      : (chatterboxUsesPytorch ? 'chatterbox-server.py' : 'chatterbox-mlx-server.py')
  );
  const chatterboxVenvPython = options.chatterboxVenvPython || path.join(
    rootDir,
    chatterboxUsesPytorch ? 'chatterbox-venv' : 'mlx-venv',
    'bin',
    'python'
  );
  const chatterboxVoiceDir = options.chatterboxVoiceDir || path.join(dataDir, 'voice-references');
  const chatterboxPidFile = options.chatterboxPidFile || path.join(dataDir, 'runtime', 'chatterbox.pid');
  const healthOverrides = options.health || {};
  const shouldAutoStartOverrides = options.shouldAutoStart || {};
  const pidStore = options.pidStore || createPidStore({ fs, filePath: chatterboxPidFile });

  let kokoroProcess = null;
  let chatterboxProcess = null;
  let chatterboxOwnedPid = null;
  let chatterboxRestartTimer = null;
  let chatterboxStableTimer = null;
  let chatterboxRestartAttempt = 0;
  let chatterboxStopping = false;
  let chatterboxStartingPromise = null;
  let chatterboxStartingGeneration = null;
  let chatterboxLifecycleGeneration = 0;

  function shouldAutoStart(engine) {
    if (typeof shouldAutoStartOverrides[engine] === 'function') {
      return shouldAutoStartOverrides[engine]();
    }
    if (engine === 'kokoro') {
      return shouldAutoStartLocal({ disabled: env.KOKORO_AUTO_START, serverPath: kokoroServerPath, configuredUrl: env.KOKORO_TTS_URL, fs });
    }
    return shouldAutoStartLocal({ disabled: env.CHATTERBOX_AUTO_START, serverPath: chatterboxServerPath, configuredUrl: env.CHATTERBOX_TTS_URL, fs });
  }

  function processExists(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (typeof processes.exists === 'function') return Boolean(processes.exists(pid));
    try {
      (processes.kill || process.kill.bind(process))(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function processCommand(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return '';
    if (typeof processes.command === 'function') return processes.command(pid) || '';
    try {
      return (processes.execFileSync || execFileSync)('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {
      return '';
    }
  }

  function chatterboxPort() {
    try {
      if (env.CHATTERBOX_TTS_URL) return new URL(env.CHATTERBOX_TTS_URL).port || '80';
    } catch {}
    return String(env.CHATTERBOX_PORT || '8767');
  }

  function findChatterboxProcesses() {
    if (typeof processes.findChatterbox === 'function') return processes.findChatterbox() || [];
    const pattern = new RegExp(`\\bxandrio-chatterbox(?:-mlx|-v3)?:${chatterboxPort()}\\b`);
    try {
      return (processes.execFileSync || execFileSync)('ps', ['-axo', 'pid=,command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .split('\n')
        .map(line => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          return match ? { pid: Number(match[1]), command: match[2] } : null;
        })
        .filter(entry => entry && pattern.test(entry.command) && processExists(entry.pid));
    } catch {
      return [];
    }
  }

  function isManagedChatterboxProcess(pid) {
    if (typeof processes.isChatterboxProcess === 'function') {
      return Boolean(processes.isChatterboxProcess(pid));
    }
    return /\bxandrio-chatterbox(?:-mlx|-v3)?:\d+\b/.test(processCommand(pid));
  }

  function terminate(pid, signal) {
    try {
      (processes.kill || process.kill.bind(process))(pid, signal);
    } catch {}
  }

  async function waitForProcessExit(pid, timeoutMs) {
    if (typeof processes.waitForExit === 'function') return processes.waitForExit(pid, timeoutMs);
    const started = clock.now();
    while (processExists(pid) && clock.now() - started < timeoutMs) {
      await sleep(100, timers);
    }
    return !processExists(pid);
  }

  function kokoroPython() {
    if (env.KOKORO_PYTHON) return env.KOKORO_PYTHON;
    return fs.existsSync(kokoroVenvPython) ? kokoroVenvPython : 'python3';
  }

  function chatterboxPython() {
    if (env.CHATTERBOX_PYTHON) return env.CHATTERBOX_PYTHON;
    return fs.existsSync(chatterboxVenvPython) ? chatterboxVenvPython : 'python3';
  }

  function kokoroChildEnv() {
    return childEnv({ env, urlVariable: 'KOKORO_TTS_URL', portVariable: 'KOKORO_PORT', hostVariable: 'KOKORO_HOST' });
  }

  function chatterboxChildEnv() {
    const child = { ...env };
    if (!child.CHATTERBOX_VOICE_DIR) child.CHATTERBOX_VOICE_DIR = chatterboxVoiceDir;
    return childEnv({
      env: child,
      urlVariable: 'CHATTERBOX_TTS_URL',
      portVariable: 'CHATTERBOX_PORT',
      hostVariable: 'CHATTERBOX_HOST'
    });
  }

  function spawnEngine(engine) {
    const spec = engine === 'kokoro'
      ? {
          title: `xandrio-kokoro:${env.KOKORO_PORT || '8766'}`,
          executable: kokoroPython(),
          args: [kokoroServerPath],
          options: { cwd: rootDir, env: kokoroChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
        }
      : {
          title: `${
            chatterboxUsesV3
              ? 'xandrio-chatterbox-v3'
              : (chatterboxUsesPytorch ? 'xandrio-chatterbox' : 'xandrio-chatterbox-mlx')
          }:${env.CHATTERBOX_PORT || '8767'}`,
          executable: chatterboxPython(),
          args: [chatterboxServerPath],
          options: { cwd: rootDir, env: chatterboxChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
        };
    if (typeof processes.spawn === 'function') return processes.spawn(engine, spec);
    return spawnNamedProcess({ spec, platform, fs, rawSpawn: processes.rawSpawn || spawn });
  }

  async function checkChatterboxHealth(timeoutMs = 2500) {
    if (typeof healthOverrides.chatterbox === 'function') return healthOverrides.chatterbox(timeoutMs);
    return fetchHealth({
      base: env.CHATTERBOX_TTS_URL || 'http://127.0.0.1:8767',
      timeoutMs,
      timers,
      fetch: healthClient.fetch || globalThis.fetch,
      AbortController: healthClient.AbortController || globalThis.AbortController
    });
  }

  async function checkKokoroHealth(timeoutMs = 2500) {
    if (typeof healthOverrides.kokoro === 'function') return healthOverrides.kokoro(timeoutMs);
    const status = await fetchHealth({
      base: env.KOKORO_TTS_URL || 'http://127.0.0.1:8766',
      timeoutMs,
      timers,
      fetch: healthClient.fetch || globalThis.fetch,
      AbortController: healthClient.AbortController || globalThis.AbortController
    });
    return status.up;
  }

  function adoptChatterboxPid(pid) {
    chatterboxOwnedPid = pid;
    logger.log(`Using existing Chatterbox process pid=${pid}`);
  }

  function stopDuplicateChatterboxProcesses(keepPid) {
    for (const entry of findChatterboxProcesses()) {
      if (entry.pid === keepPid) continue;
      logger.warn(`Stopping duplicate Chatterbox process pid=${entry.pid} command="${entry.command}"`);
      terminate(entry.pid, 'SIGTERM');
    }
  }

  function isChatterboxStartCurrent(generation) {
    return !chatterboxStopping && generation === chatterboxLifecycleGeneration;
  }

  async function adoptExistingChatterboxIfHealthy(generation) {
    const pid = pidStore.read();
    if (pid && !processExists(pid)) pidStore.remove(pid);
    const discovered = findChatterboxProcesses();
    const status = await checkChatterboxHealth(1000);
    if (!isChatterboxStartCurrent(generation)) return null;
    if (!status?.up) {
      const candidates = pid && processExists(pid)
        ? [{ pid, command: processCommand(pid) }]
        : discovered;
      for (const candidate of candidates) {
        const candidatePid = candidate.pid;
        if (isManagedChatterboxProcess(candidatePid)) {
          logger.warn(`Stopping unhealthy Chatterbox process pid=${candidatePid}${candidate.command ? ` command="${candidate.command}"` : ''}`);
          terminate(candidatePid, 'SIGTERM');
          await waitForProcessExit(candidatePid, 3000);
          if (!isChatterboxStartCurrent(generation)) return null;
          if (processExists(candidatePid)) {
            logger.warn(`Chatterbox process pid=${candidatePid} did not exit after SIGTERM; sending SIGKILL`);
            terminate(candidatePid, 'SIGKILL');
            await waitForProcessExit(candidatePid, 1000);
            if (!isChatterboxStartCurrent(generation)) return null;
            if (processExists(candidatePid)) {
              logger.warn(`Chatterbox process pid=${candidatePid} did not exit after SIGKILL; not spawning a duplicate`);
              return true;
            }
          }
        } else {
          logger.warn(`Removing stale Chatterbox pid file; pid=${candidatePid} is not an Xandrio Chatterbox process${candidate.command ? ` command="${candidate.command}"` : ''}`);
        }
      }
      if (pid) pidStore.remove(pid);
      return false;
    }

    if (pid && processExists(pid) && isManagedChatterboxProcess(pid)) {
      adoptChatterboxPid(pid);
      stopDuplicateChatterboxProcesses(pid);
    } else if (discovered.length > 0) {
      const adopted = discovered[0].pid;
      adoptChatterboxPid(adopted);
      pidStore.write(adopted);
      stopDuplicateChatterboxProcesses(adopted);
    } else {
      // Another healthy process owns the endpoint. Do not claim its PID.
      logger.log('Using existing healthy Chatterbox endpoint');
    }
    return true;
  }

  function scheduleChatterboxRestart() {
    if (chatterboxStopping || chatterboxStartingPromise || !shouldAutoStart('chatterbox') || chatterboxRestartTimer) return;
    const configuredBase = Number(options.chatterboxRestartDelayMs ?? env.CHATTERBOX_RESTART_DELAY_MS);
    const configuredMax = Number(options.chatterboxRestartMaxDelayMs ?? env.CHATTERBOX_RESTART_MAX_DELAY_MS);
    const baseDelay = Number.isFinite(configuredBase) && configuredBase > 0 ? Math.max(250, configuredBase) : 1000;
    const maxDelay = Number.isFinite(configuredMax) && configuredMax >= baseDelay ? configuredMax : 30000;
    const delay = Math.min(maxDelay, baseDelay * (2 ** Math.min(chatterboxRestartAttempt, 5)));
    chatterboxRestartAttempt++;
    logger.warn(`Restarting Chatterbox in ${delay}ms`);
    const generation = chatterboxLifecycleGeneration;
    chatterboxRestartTimer = timers.setTimeout(async () => {
      chatterboxRestartTimer = null;
      if (!isChatterboxStartCurrent(generation)) return;
      try {
        await startChatterbox({ explicit: false });
      } catch (err) {
        logger.warn(`Chatterbox restart failed: ${err.message}`);
      }
    }, delay);
    chatterboxRestartTimer?.unref?.();
  }

  function attachChildOutput(child, engine) {
    child.stdout?.on?.('data', data => output.stdout?.write?.(`[${engine}] ${data}`));
    child.stderr?.on?.('data', data => output.stderr?.write?.(`[${engine}] ${data}`));
  }

  function startKokoro() {
    if (!shouldAutoStart('kokoro') || kokoroProcess) return;
    const python = kokoroPython();
    const child = spawnEngine('kokoro');
    if (!child) return;
    kokoroProcess = child;
    attachChildOutput(child, 'kokoro');
    child.on?.('error', err => {
      logger.error(`Kokoro auto-start failed: ${err.message}`);
      if (kokoroProcess === child) kokoroProcess = null;
    });
    child.on?.('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        logger.error(`Kokoro server exited (${signal || code}). Select Edge TTS or start Kokoro manually.`);
      }
      if (kokoroProcess === child) kokoroProcess = null;
    });
    logger.log(`Starting Kokoro TTS server with ${python}`);
  }

  function stopKokoro() {
    if (!kokoroProcess) return;
    try {
      kokoroProcess.kill?.('SIGTERM');
    } catch {}
    kokoroProcess = null;
  }

  function clearChatterboxStableTimer() {
    if (!chatterboxStableTimer) return;
    timers.clearTimeout(chatterboxStableTimer);
    chatterboxStableTimer = null;
  }

  function superviseChatterboxChild(child) {
    child.on?.('error', err => {
      logger.error(`Chatterbox auto-start failed: ${err.message}`);
      if (chatterboxProcess === child) chatterboxProcess = null;
      if (chatterboxOwnedPid === child.pid) chatterboxOwnedPid = null;
      pidStore.remove(child.pid);
      scheduleChatterboxRestart();
    });
    child.on?.('exit', (code, signal) => {
      logger.warn(`Chatterbox child exited code=${code ?? 'null'} signal=${signal || 'none'}`);
      if (code !== 0 && signal !== 'SIGTERM') {
        logger.error(`Chatterbox server exited (${signal || code}). Select Edge/Kokoro TTS or start Chatterbox manually.`);
      }
      if (chatterboxProcess === child) chatterboxProcess = null;
      if (chatterboxOwnedPid === child.pid) chatterboxOwnedPid = null;
      pidStore.remove(child.pid);
      clearChatterboxStableTimer();
      scheduleChatterboxRestart();
    });
  }

  async function startChatterboxOnce(generation) {
    const adopted = await adoptExistingChatterboxIfHealthy(generation);
    if (!isChatterboxStartCurrent(generation) || adopted) return;
    if (chatterboxRestartTimer) {
      timers.clearTimeout(chatterboxRestartTimer);
      chatterboxRestartTimer = null;
    }
    const python = chatterboxPython();
    const child = spawnEngine('chatterbox');
    if (!child) return;
    chatterboxProcess = child;
    chatterboxOwnedPid = child.pid;
    pidStore.write(child.pid);

    clearChatterboxStableTimer();
    const configuredStableMs = Number(options.chatterboxStableMs ?? env.CHATTERBOX_STABLE_MS);
    const stableMs = Number.isFinite(configuredStableMs) && configuredStableMs > 0 ? configuredStableMs : 30000;
    chatterboxStableTimer = timers.setTimeout(() => {
      if (chatterboxProcess === child) chatterboxRestartAttempt = 0;
    }, stableMs);
    chatterboxStableTimer?.unref?.();

    attachChildOutput(child, 'chatterbox');
    superviseChatterboxChild(child);
    const modelLabel = chatterboxUsesV3
      ? 'Multilingual V3 PyTorch/MPS'
      : (chatterboxUsesV3Mlx
          ? 'V3 MLX 8-bit (English)'
          : (chatterboxUsesPytorch ? 'Turbo PyTorch' : 'Original MLX 8-bit'));
    logger.log(`Starting Chatterbox TTS server (${modelLabel}) with ${python}`);
  }

  async function startChatterbox({ explicit = true } = {}) {
    if (explicit) chatterboxStopping = false;
    if (chatterboxOwnedPid && !processExists(chatterboxOwnedPid)) {
      pidStore.remove(chatterboxOwnedPid);
      chatterboxOwnedPid = null;
    }
    if (!shouldAutoStart('chatterbox') || chatterboxProcess || chatterboxOwnedPid) return;
    const generation = chatterboxLifecycleGeneration;
    if (chatterboxStartingPromise && chatterboxStartingGeneration === generation) return chatterboxStartingPromise;
    const startPromise = startChatterboxOnce(generation)
      .catch(err => logger.warn(`Chatterbox start failed: ${err.message}`))
      .finally(() => {
        if (chatterboxStartingPromise === startPromise) {
          chatterboxStartingPromise = null;
          chatterboxStartingGeneration = null;
        }
      });
    chatterboxStartingPromise = startPromise;
    chatterboxStartingGeneration = generation;
    return startPromise;
  }

  function stopChatterbox() {
    chatterboxStopping = true;
    chatterboxLifecycleGeneration++;
    if (chatterboxRestartTimer) {
      timers.clearTimeout(chatterboxRestartTimer);
      chatterboxRestartTimer = null;
    }
    clearChatterboxStableTimer();
    if (chatterboxProcess) {
      try {
        chatterboxProcess.kill?.('SIGTERM');
      } catch {}
      chatterboxProcess = null;
    } else if (chatterboxOwnedPid && processExists(chatterboxOwnedPid)) {
      terminate(chatterboxOwnedPid, 'SIGTERM');
    }
    pidStore.remove(chatterboxOwnedPid);
    chatterboxOwnedPid = null;
  }

  function start(engine) {
    if (engine === 'kokoro') return startKokoro();
    if (engine === 'chatterbox') return startChatterbox();
  }

  function stop(engine) {
    if (engine === 'kokoro') return stopKokoro();
    if (engine === 'chatterbox') return stopChatterbox();
  }

  async function isEngineHealthy(engine) {
    if (engine === 'edge') return true;
    const result = engine === 'kokoro'
      ? await checkKokoroHealth(2500)
      : await checkChatterboxHealth(2500);
    return typeof result === 'boolean' ? result : Boolean(result?.up);
  }

  function processHint(engine) {
    if (engine === 'kokoro') return Boolean(kokoroProcess);
    if (engine === 'chatterbox') {
      return Boolean(
        chatterboxProcess ||
        chatterboxOwnedPid ||
        (chatterboxStartingPromise && isChatterboxStartCurrent(chatterboxStartingGeneration)) ||
        chatterboxRestartTimer
      );
    }
    return false;
  }

  function lifecycleBindings() {
    return {
      edgeHealth: () => isEngineHealthy('edge'),
      kokoroStart: () => start('kokoro'),
      kokoroStop: () => stop('kokoro'),
      kokoroHealth: () => isEngineHealthy('kokoro'),
      kokoroProcessHint: () => processHint('kokoro'),
      chatterboxStart: () => start('chatterbox'),
      chatterboxStop: () => stop('chatterbox'),
      chatterboxHealth: () => isEngineHealthy('chatterbox'),
      chatterboxProcessHint: () => processHint('chatterbox')
    };
  }

  return { start, stop, health: isEngineHealthy, processHint, lifecycleBindings };
}

function createPidStore({ fs, filePath }) {
  function read() {
    try {
      const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
  return {
    read,
    write(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${pid}\n`);
    },
    remove(expectedPid = null) {
      try {
        if (expectedPid !== null && read() !== expectedPid) return;
        fs.unlinkSync(filePath);
      } catch {}
    }
  };
}

function shouldAutoStartLocal({ disabled, serverPath, configuredUrl, fs }) {
  if (disabled === 'false' || !fs.existsSync(serverPath)) return false;
  if (!configuredUrl) return true;
  try {
    const host = new URL(configuredUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0';
  } catch {
    return true;
  }
}

function childEnv({ env, urlVariable, portVariable, hostVariable }) {
  const child = { ...env };
  if (!child[urlVariable]) return child;
  try {
    const url = new URL(child[urlVariable]);
    if (!child[portVariable] && url.port) child[portVariable] = url.port;
    if (!child[hostVariable] && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
      child[hostVariable] = '127.0.0.1';
    }
  } catch {
    // Keep the child environment unchanged if the configured URL is malformed.
  }
  return child;
}

function spawnNamedProcess({ spec, platform, fs, rawSpawn }) {
  if (platform !== 'darwin' || !fs.existsSync('/bin/zsh')) {
    return rawSpawn(spec.executable, spec.args, spec.options);
  }
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = `exec -a ${quote(spec.title)} ${quote(spec.executable)} ${spec.args.map(quote).join(' ')}`;
  return rawSpawn('/bin/zsh', ['-lc', command], spec.options);
}

async function fetchHealth({ base, timeoutMs, timers, fetch, AbortController }) {
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
    return { up: false, error: 'Health probing is unavailable' };
  }
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL('/health', base), { signal: controller.signal });
    if (!res.ok) return { up: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    return body && body.ok ? { up: true, body } : { up: false, error: 'Invalid health response' };
  } catch (err) {
    return { up: false, error: err.message };
  } finally {
    timers.clearTimeout(timer);
  }
}

function sleep(delayMs, timers) {
  return new Promise(resolve => timers.setTimeout(resolve, delayMs));
}

module.exports = { createNarrationRuntime };
