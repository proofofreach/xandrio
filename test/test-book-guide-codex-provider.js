'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCodexBookGuideProvider, codexDigest } = require('../lib/book-guide-codex-provider');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function childResult({ stdout = '', stderr = '', code = 0, stayOpen = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => setImmediate(() => child.emit('close', 143));
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    if (!stayOpen) setImmediate(() => child.emit('close', code));
  });
  return child;
}

async function run() {
  const calls = [];
  const ensuredHomes = [];
  let connected = true;
  const spawnImpl = (_binary, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'login' && args[1] === 'status') {
      return childResult(connected ? { stdout: 'Logged in using ChatGPT\n' } : { stderr: 'Not logged in\n', code: 1 });
    }
    if (args[0] === 'login' && args[1] === '--device-auth') {
      return childResult({ stdout: 'Use the command-line flow. Open https://auth.openai.com/codex/device and enter ABCD-EFGHI\n', stayOpen: true });
    }
    if (args[0] === 'logout') {
      connected = false;
      return childResult({ stdout: 'Logged out\n' });
    }
    return childResult({ stdout: '{"claims":[]}\n' });
  };
  const provider = createCodexBookGuideProvider({
    codexHome: '/private/codex-home',
    spawnImpl,
    ensureHomeImpl: async home => ensuredHomes.push(home)
  });

  await test('uses a dedicated Codex home and supported subscription model identity', async () => {
    const model = await provider.inspect({ model: 'gpt-5.6-luna' });
    assert.deepStrictEqual(model, { name: 'gpt-5.6-luna', digest: codexDigest('gpt-5.6-luna') });
    assert.strictEqual(calls[0].options.env.CODEX_HOME, '/private/codex-home');
    assert.deepStrictEqual(ensuredHomes, ['/private/codex-home']);
    await assert.rejects(provider.inspect({ model: 'unknown' }), error => error.code === 'BOOK_GUIDE_MODEL_REQUIRED');
  });

  await test('runs generation ephemerally in a read-only sandbox and parses final JSON', async () => {
    const result = await provider.generate({
      modelSnapshot: { name: 'gpt-5.6-luna', digest: codexDigest('gpt-5.6-luna') },
      prompt: 'Return claims.',
      purpose: 'generation'
    });
    assert.deepStrictEqual(result, { claims: [] });
    const exec = calls.find(call => call.args[0] === 'exec');
    assert(exec.args.includes('--ephemeral'));
    assert.deepStrictEqual(exec.args.slice(exec.args.indexOf('--sandbox'), exec.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert(exec.args.includes('--ignore-user-config') && exec.args.includes('--ignore-rules'));
  });

  await test('returns only the device URL and temporary code to the caller', async () => {
    connected = false;
    await provider.beginLogin();
    await new Promise(resolve => setImmediate(resolve));
    const state = await provider.pollLogin();
    assert.strictEqual(state.state, 'waiting');
    assert.strictEqual(state.verificationUrl, 'https://auth.openai.com/codex/device');
    assert.strictEqual(state.userCode, 'ABCD-EFGHI');
    assert(!JSON.stringify(state).includes('/private/codex-home'));
  });

  await test('disconnects through Codex without exposing cached credentials', async () => {
    const status = await provider.disconnect();
    assert.strictEqual(status.connected, false);
    assert(calls.some(call => call.args.join(' ') === 'logout'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
