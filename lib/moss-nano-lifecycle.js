const path = require('path');
const fs = require('fs');
const { enabled, baseUrl } = require('./moss-nano-tuning');

// Nano is opt-in. External supervisors own their worker; this lifecycle only
// stops a child it spawned and never searches for or kills unrelated processes.
function createMossNanoLifecycle({ rootDir, env = process.env, spawn, fetch = globalThis.fetch, logger = console }) {
  let child = null, starting = null, generation = 0;
  const python = env.MOSS_NANO_PYTHON || path.join(rootDir, 'moss-nano-venv/bin/python');
  const models = env.MOSS_NANO_MODEL_DIR || path.join(rootDir, 'moss-nano/models');
  const localInstalled = () => fs.existsSync(python) && fs.existsSync(path.join(models, 'MOSS-TTS-Nano-100M-ONNX/browser_poc_manifest.json'));
  const autoStart = () => enabled(env) && env.MOSS_NANO_AUTO_START === 'true';
  function statusHint() {
    if (!enabled(env)) return 'disabled';
    if (autoStart() && !localInstalled()) return 'models-uninstalled';
    return child || starting ? 'starting' : 'offline';
  }
  async function health() {
    if (!enabled(env)) return false;
    try { return (await fetch(`${baseUrl(env)}/health`, { signal: AbortSignal.timeout(2500) })).ok; }
    catch { return false; }
  }
  function start() {
    if (!autoStart() || !localInstalled() || child) return Promise.resolve(false);
    if (starting) return starting;
    const current = generation;
    starting = (async () => {
      if (await health() || current !== generation) return false;
      const url = new URL(baseUrl(env));
      if (!['localhost', '127.0.0.1'].includes(url.hostname)) return false;
      const owned = spawn(python, [path.join(rootDir, 'moss-nano/server.py')], {
        cwd: rootDir, env: { ...env, MOSS_NANO_HOST: '127.0.0.1', MOSS_NANO_PORT: url.port || '8768', MOSS_NANO_MODEL_DIR: models },
        stdio: ['ignore', 'inherit', 'inherit']
      });
      child = owned;
      const clear = () => { if (child === owned) child = null; };
      owned.once('exit', clear);
      owned.once('error', error => { clear(); logger.warn(`Nano worker failed to start: ${error.message}`); });
      return true;
    })().catch(error => { logger.warn(`Nano startup failed: ${error.message}`); return false; })
      .finally(() => { starting = null; });
    return starting;
  }
  function stop() { generation++; const owned = child; child = null; owned?.kill('SIGTERM'); }
  return { start, stop, health, processHint: () => Boolean(child || starting), statusHint };
}

module.exports = { createMossNanoLifecycle };
