const assert = require('assert');
const { app } = require('../server');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

(async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await test('legacy chunk route redirects into canonical playback access', async () => {
      const response = await fetch(`${base}/api/serve-chunk/book_one_tts0123456789_ch2_chunk3.mp3`, {
        redirect: 'manual'
      });
      assert.strictEqual(response.status, 307);
      assert.strictEqual(response.headers.get('location'), '/api/chunks/book_one/2/3');
    });

    await test('legacy chunk route rejects filenames outside playback identity', async () => {
      const response = await fetch(`${base}/api/serve-chunk/not-an-audio-file.mp3`, { redirect: 'manual' });
      assert.strictEqual(response.status, 403);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`playback-route tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
