'use strict';

const crypto = require('node:crypto');
const { spawn: spawnDefault } = require('node:child_process');
const fs = require('node:fs/promises');
const { parseStructuredContent, providerError } = require('./book-guide-provider');

const CODEX_BASE_URL = 'codex://subscription';
const CODEX_MODELS = new Set(['gpt-5.6-luna', 'gpt-5.6-terra']);
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function codexDigest(model) {
  return `sha256:${crypto.createHash('sha256').update(`codex-subscription\0${model}`).digest('hex')}`;
}

function createCollector(maxBytes) {
  let value = '';
  return {
    append(chunk) {
      value += String(chunk || '').replace(ANSI, '');
      if (Buffer.byteLength(value) > maxBytes) {
        throw providerError('Codex output exceeded the safe limit', 'BOOK_GUIDE_PROVIDER_RESPONSE_INVALID', 502);
      }
    },
    value: () => value
  };
}

function safeVerificationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'openai.com' || host.endsWith('.openai.com') || host === 'chatgpt.com' || host.endsWith('.chatgpt.com'))) return '';
    return url.href;
  } catch {
    return '';
  }
}

function createCodexBookGuideProvider({
  codexHome,
  binary = 'codex',
  spawnImpl = spawnDefault,
  ensureHomeImpl = async home => {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.chmod(home, 0o700);
  },
  timeoutMs = 180000,
  maxResponseBytes = 4 * 1024 * 1024
} = {}) {
  if (!codexHome) throw new TypeError('codexHome is required');
  let login = null;

  const commandEnv = () => ({
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    LANG: process.env.LANG || 'C.UTF-8',
    CODEX_HOME: codexHome
  });

  async function ensureHome() {
    try {
      await ensureHomeImpl(codexHome);
    } catch {
      throw providerError('Codex credential storage is unavailable', 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503);
    }
  }

  async function run(args, { input = '', signal = null, timeout = timeoutMs, maxBytes = maxResponseBytes } = {}) {
    await ensureHome();
    return new Promise((resolve, reject) => {
      const child = spawnImpl(binary, args, {
        env: commandEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      const stdout = createCollector(maxBytes);
      const stderr = createCollector(Math.min(maxBytes, 256 * 1024));
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => {
        child.kill('SIGTERM');
        finish(providerError('Codex request cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503));
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(providerError('Codex did not finish before the request timeout', 'BOOK_GUIDE_PROVIDER_ABORTED', 503));
      }, Math.max(1000, timeout));
      timer.unref?.();
      child.on('error', () => finish(providerError('Codex CLI is unavailable', 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503)));
      child.stdout?.on('data', chunk => { try { stdout.append(chunk); } catch (error) { child.kill('SIGTERM'); finish(error); } });
      child.stderr?.on('data', chunk => { try { stderr.append(chunk); } catch (error) { child.kill('SIGTERM'); finish(error); } });
      child.on('close', code => finish(null, { code, stdout: stdout.value().trim(), stderr: stderr.value().trim() }));
      signal?.addEventListener?.('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      child.stdin?.end(String(input || ''));
    });
  }

  async function connectionStatus() {
    const result = await run(['login', 'status'], { timeout: 15000, maxBytes: 64 * 1024 }).catch(() => null);
    const connected = result?.code === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`);
    return {
      available: Boolean(result),
      connected,
      state: connected ? 'connected' : 'disconnected',
      label: connected ? 'Connected with ChatGPT' : 'Not connected'
    };
  }

  function loginState() {
    if (!login) return null;
    return {
      state: login.state,
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      message: login.message
    };
  }

  async function beginLogin() {
    if (login?.state === 'waiting') return loginState();
    if ((await connectionStatus()).connected) {
      login = { state: 'connected', verificationUrl: '', userCode: '', message: 'Codex is connected.' };
      return loginState();
    }
    await ensureHome();
    const child = spawnImpl(binary, ['login', '--device-auth'], {
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    login = { child, state: 'starting', verificationUrl: '', userCode: '', message: 'Starting secure sign-in…', output: '' };
    const consume = chunk => {
      if (!login || login.child !== child) return;
      login.output = `${login.output}${String(chunk || '').replace(ANSI, '')}`.slice(-65536);
      login.verificationUrl = safeVerificationUrl(login.output.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/, ''));
      const codes = login.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/gi) || [];
      login.userCode = codes.at(-1)?.toUpperCase() || '';
      login.state = login.verificationUrl || login.userCode ? 'waiting' : 'starting';
      login.message = login.state === 'waiting' ? 'Complete sign-in in your browser.' : 'Preparing device authorization…';
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('error', () => {
      if (login?.child === child) Object.assign(login, { state: 'failed', message: 'Codex CLI is unavailable.' });
    });
    child.on('close', async code => {
      if (login?.child !== child) return;
      const status = code === 0 ? await connectionStatus() : { connected: false };
      Object.assign(login, status.connected
        ? { state: 'connected', message: 'Codex is connected.' }
        : { state: 'failed', message: 'Sign-in did not complete. Try again.' });
    });
    const loginTimeout = setTimeout(() => {
      if (login?.child !== child || !['starting', 'waiting'].includes(login.state)) return;
      child.kill('SIGTERM');
      Object.assign(login, { state: 'failed', message: 'The sign-in code expired. Try again.' });
    }, 10 * 60 * 1000);
    loginTimeout.unref?.();
    child.once('close', () => clearTimeout(loginTimeout));
    return loginState();
  }

  async function pollLogin() {
    const current = loginState();
    if (current && ['starting', 'waiting'].includes(current.state)) return current;
    if (current?.state === 'connected' || current?.state === 'failed') return current;
    return connectionStatus();
  }

  async function disconnect() {
    if (login?.child && ['starting', 'waiting'].includes(login.state)) login.child.kill('SIGTERM');
    login = null;
    const result = await run(['logout'], { timeout: 15000, maxBytes: 64 * 1024 });
    if (result.code !== 0 && !/not logged in/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw providerError('Codex could not disconnect', 'BOOK_GUIDE_PROVIDER_UNAVAILABLE', 503);
    }
    return connectionStatus();
  }

  async function inspect({ model, signal = null }) {
    if (!CODEX_MODELS.has(model)) throw providerError('Choose a supported Codex model', 'BOOK_GUIDE_MODEL_REQUIRED', 400);
    if (signal?.aborted) throw providerError('Codex request cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
    if (!(await connectionStatus()).connected) {
      throw providerError('Connect Codex in Study Guide settings', 'BOOK_GUIDE_PROVIDER_CREDENTIALS_MISSING', 409);
    }
    return { name: model, digest: codexDigest(model) };
  }

  async function generate({ modelSnapshot, prompt, purpose = 'generation', signal = null }) {
    const model = String(modelSnapshot?.name || '');
    if (!CODEX_MODELS.has(model)) {
      throw providerError('Choose a supported Codex guide model', 'BOOK_GUIDE_MODEL_REQUIRED', 400);
    }
    if (signal?.aborted) throw providerError('Codex request cancelled', 'BOOK_GUIDE_PROVIDER_ABORTED', 503);
    const expected = { name: model, digest: codexDigest(model) };
    if (modelSnapshot?.digest !== expected.digest) {
      throw providerError('Configured Codex model identity changed', 'BOOK_GUIDE_MODEL_CHANGED', 409);
    }
    const effort = purpose === 'composition' ? 'medium' : 'low';
    const result = await run([
      'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--model', expected.name, '-c', `model_reasoning_effort="${effort}"`,
      'Return only the JSON object requested in the supplied study-guide prompt. Do not run tools or inspect files.'
    ], { input: String(prompt || ''), signal });
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      const code = /login|authentication|unauthorized/i.test(combined)
        ? 'BOOK_GUIDE_PROVIDER_CREDENTIALS_INVALID'
        : 'BOOK_GUIDE_PROVIDER_UNAVAILABLE';
      throw providerError('Codex could not generate the study guide response', code, 503);
    }
    return parseStructuredContent(result.stdout);
  }

  return {
    id: 'codex-subscription',
    label: 'Codex subscription',
    external: true,
    authMode: 'device',
    models: [
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', detail: 'Best value for guide generation' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', detail: 'Stronger independent verifier' }
    ],
    beginLogin,
    connectionStatus,
    disconnect,
    generate,
    hasCredentials: async () => (await connectionStatus()).connected,
    inspect,
    normalizeBaseUrl: () => CODEX_BASE_URL,
    pollLogin
  };
}

module.exports = { CODEX_BASE_URL, CODEX_MODELS, codexDigest, createCodexBookGuideProvider, safeVerificationUrl };
