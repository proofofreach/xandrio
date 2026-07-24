const assert = require('assert');
const { createGracefulShutdown } = require('../lib/graceful-shutdown');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

async function main() {
  await test('stops accepting requests, drains work, cleans up, then exits', async () => {
    const calls = [];
    let closeCallback;
    let idle = false;
    const server = {
      close(callback) { calls.push('close'); closeCallback = callback; },
      closeIdleConnections() { calls.push('close-idle'); },
      closeAllConnections() { calls.push('close-all'); }
    };
    const controller = createGracefulShutdown({
      getServer: () => server,
      isIdle: () => idle,
      cleanup: async () => { calls.push('cleanup'); },
      exit: code => { calls.push(`exit:${code}`); },
      timeoutMs: 200,
      pollMs: 2
    });
    const pending = controller.shutdown(0);
    await new Promise(resolve => setTimeout(resolve, 5));
    idle = true;
    closeCallback();
    await pending;
    assert.deepStrictEqual(calls, ['close', 'close-idle', 'cleanup', 'exit:0']);
  });

  await test('a stuck connection is force-closed at the deadline', async () => {
    const calls = [];
    const server = {
      close() { calls.push('close'); },
      closeIdleConnections() { calls.push('close-idle'); },
      closeAllConnections() { calls.push('close-all'); }
    };
    const controller = createGracefulShutdown({
      getServer: () => server,
      isIdle: () => false,
      cleanup: async () => { calls.push('cleanup'); },
      exit: code => { calls.push(`exit:${code}`); },
      timeoutMs: 10,
      pollMs: 2
    });
    await controller.shutdown(1);
    assert.deepStrictEqual(calls, ['close', 'close-idle', 'close-all', 'cleanup', 'exit:1']);
  });

  await test('repeated shutdown signals share one drain', async () => {
    let exits = 0;
    const controller = createGracefulShutdown({
      getServer: () => null,
      cleanup: async () => {},
      exit: () => { exits++; }
    });
    const first = controller.shutdown(0);
    const second = controller.shutdown(0);
    assert.strictEqual(first, second);
    await first;
    assert.strictEqual(exits, 1);
  });

  console.log(`\ngraceful-shutdown tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
