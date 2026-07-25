const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

function streamedResponse(chunks) {
  const bytes = chunks.map(chunk => new Uint8Array(chunk));
  const size = bytes.reduce((total, chunk) => total + chunk.byteLength, 0);
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = bytes.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    }
  }), {
    headers: {
      'Content-Length': String(size),
      'Content-Type': 'audio/mpeg',
      'ETag': '"fixture"'
    }
  });
}

(async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'offline-range.js'),
    'utf8'
  );
  Function(source)();
  const { createRangeResponse } = global.XandrioOfflineRange;

  await test('streams a bounded cached-audio range without materializing the chapter', async () => {
    const cached = streamedResponse([
      [0, 1, 2],
      [3, 4, 5, 6],
      [7, 8, 9]
    ]);
    cached.arrayBuffer = () => {
      throw new Error('whole response must not be buffered');
    };

    const response = await createRangeResponse(cached, 'bytes=2-7');

    assert.strictEqual(response.status, 206);
    assert.strictEqual(response.headers.get('Content-Range'), 'bytes 2-7/10');
    assert.strictEqual(response.headers.get('Content-Length'), '6');
    assert.strictEqual(response.headers.get('ETag'), '"fixture"');
    assert.deepStrictEqual(
      [...new Uint8Array(await response.arrayBuffer())],
      [2, 3, 4, 5, 6, 7]
    );
  });

  await test('supports suffix and open-ended byte ranges', async () => {
    const suffix = await createRangeResponse(
      streamedResponse([[0, 1, 2, 3, 4, 5]]),
      'bytes=-2'
    );
    assert.deepStrictEqual([...new Uint8Array(await suffix.arrayBuffer())], [4, 5]);

    const open = await createRangeResponse(
      streamedResponse([[0, 1, 2], [3, 4, 5]]),
      'bytes=3-'
    );
    assert.deepStrictEqual([...new Uint8Array(await open.arrayBuffer())], [3, 4, 5]);
  });

  await test('rejects invalid and unsatisfiable ranges', async () => {
    for (const range of ['bytes=', 'bytes=9-10', 'items=0-1', 'bytes=4-2']) {
      const response = await createRangeResponse(
        streamedResponse([[0, 1, 2, 3, 4, 5]]),
        range
      );
      assert.strictEqual(response.status, 416, range);
      assert.strictEqual(response.headers.get('Content-Range'), 'bytes */6');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
