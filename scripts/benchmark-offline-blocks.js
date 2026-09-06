const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium, webkit } = require('playwright');

const BLOCK_SIZE = 1024 * 1024;
const sizesMiB = [1, 10, 100];
const storeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'offline-store.js'));
const transferSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'offline-transfer.mjs'));

function hash(value) {
  return `sha256-${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function benchmarkDescriptor(sizeMiB) {
  const size = sizeMiB * BLOCK_SIZE;
  const count = Math.ceil(size / BLOCK_SIZE);
  const wholeHash = crypto.createHash('sha256');
  const blockHashes = [];
  for (let index = 0; index < count; index++) {
    const length = Math.min(BLOCK_SIZE, size - (index * BLOCK_SIZE));
    const block = Buffer.alloc(length, (index + 17) % 251);
    wholeHash.update(block);
    blockHashes.push(hash(block));
  }
  const artifactId = `sha256-${wholeHash.digest('hex')}`;
  return {
    index: 0,
    state: 'ready',
    artifactId,
    contentHash: artifactId,
    etag: `"${artifactId}"`,
    size,
    blockSize: BLOCK_SIZE,
    blockHashes,
    url: '/synthetic-offline-audio',
    contentType: 'audio/mpeg'
  };
}

function selectedBrowsers() {
  const argument = process.argv.find(value => value.startsWith('--browser='));
  const requested = String(
    argument?.slice('--browser='.length) || process.env.OFFLINE_BLOCK_BENCHMARK_BROWSER || 'chromium'
  ).toLowerCase();
  if (requested === 'all') return [['chromium', chromium], ['webkit', webkit]];
  const browserType = { chromium, webkit }[requested];
  if (!browserType) throw new Error(`Unknown browser "${requested}"; use chromium, webkit, or all`);
  return [[requested, browserType]];
}

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === '/offline-store.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      return response.end(storeSource);
    }
    if (request.url === '/offline-transfer.mjs') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      return response.end(transferSource);
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><meta charset="utf-8"><title>Offline block benchmark</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const results = [];

  try {
    for (const [browserName, browserType] of selectedBrowsers()) {
      const browser = await browserType.launch({ headless: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(origin);
        await page.addScriptTag({ url: `${origin}/offline-store.js` });

        for (const sizeMiB of sizesMiB) {
          const result = await page.evaluate(async ({ descriptor, sizeMiB }) => {
            const { transferChapter } = await import('/offline-transfer.mjs');
            const store = XandrioOfflineStore.createStore({ now: () => 0, timeoutMs: 30_000 });
            const token = await store.acquireLease(`benchmark-${sizeMiB}`);
            const bookId = `benchmark-${sizeMiB}`;
            const fence = await store.captureFence(token, 'benchmark', bookId);
            await store.saveTitle('benchmark', { bookId, revision: 'r1', title: `${sizeMiB} MiB` }, fence);
            await store.putChapter('benchmark', bookId, 'r1', descriptor, fence);

            const transferMetrics = {
              getBlockCalls: 0,
              listBlocksCalls: 0,
              networkCalls: 0,
              touchedBlocks: new Set(),
              maxAddressedBytes: 0
            };
            const measuredStore = new Proxy(store, {
              get(target, property) {
                if (property === 'getBlock') return async (...args) => {
                  transferMetrics.getBlockCalls += 1;
                  transferMetrics.touchedBlocks.add(args[2]);
                  const block = await target.getBlock(...args);
                  transferMetrics.maxAddressedBytes = Math.max(
                    transferMetrics.maxAddressedBytes,
                    block?.bytes?.byteLength || 0
                  );
                  return block;
                };
                if (property === 'listBlocks') return async (...args) => {
                  transferMetrics.listBlocksCalls += 1;
                  return target.listBlocks(...args);
                };
                const value = target[property];
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
            const fetchImpl = async (_url, request) => {
              transferMetrics.networkCalls += 1;
              const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.Range);
              if (!match) throw new Error('Benchmark received a malformed range request');
              const start = Number(match[1]);
              const end = Number(match[2]);
              let offset = start;
              return new Response(new ReadableStream({
                pull(controller) {
                  if (offset > end) return controller.close();
                  const blockIndex = Math.floor(offset / descriptor.blockSize);
                  const length = Math.min(descriptor.blockSize, (end - offset) + 1);
                  controller.enqueue(new Uint8Array(length).fill((blockIndex + 17) % 251));
                  offset += length;
                }
              }), {
                status: 206,
                headers: {
                  ETag: descriptor.etag,
                  'Content-Range': `bytes ${start}-${end}/${descriptor.size}`,
                  'Content-Length': String((end - start) + 1)
                }
              });
            };

            const transferStarted = performance.now();
            let transferResult;
            do {
              transferResult = await transferChapter({
                store: measuredStore,
                descriptor,
                scope: 'benchmark',
                bookId,
                revision: 'r1',
                fence,
                fetchImpl
              });
            } while (!transferResult.complete);
            const transferMs = performance.now() - transferStarted;

            const metadataStarted = performance.now();
            const metadata = await store.listBlocks('benchmark', descriptor.artifactId);
            const metadataMs = performance.now() - metadataStarted;

            let fullReadCalls = 0;
            const fullReadStore = {
              getChapter: (...args) => store.getChapter(...args),
              getBlock: (...args) => { fullReadCalls += 1; return store.getBlock(...args); },
              listBlocks: () => { throw new Error('audio response enumerated block metadata'); }
            };
            const localUrl = `${location.origin}/__xandrio_offline__/audio/benchmark/${descriptor.artifactId}`;
            const readStarted = performance.now();
            const full = await XandrioOfflineStore.createAudioResponse(new Request(localUrl), {
              store: fullReadStore,
              workerVersion: 'benchmark'
            });
            let fullBytes = 0;
            const reader = full.body.getReader();
            while (true) {
              const item = await reader.read();
              if (item.done) break;
              fullBytes += item.value.byteLength;
            }
            const fullReadMs = performance.now() - readStarted;

            let nearEndGetBlockCalls = 0;
            let nearEndListBlocksCalls = 0;
            const nearEndTouched = new Set();
            const nearEndStore = {
              getChapter: (...args) => store.getChapter(...args),
              getBlock: async (...args) => {
                nearEndGetBlockCalls += 1;
                nearEndTouched.add(args[2]);
                return store.getBlock(...args);
              },
              listBlocks: () => {
                nearEndListBlocksCalls += 1;
                throw new Error('near-end seek enumerated block metadata');
              }
            };
            const nearEndStarted = performance.now();
            const nearEnd = await XandrioOfflineStore.createAudioResponse(new Request(localUrl, {
              headers: { Range: `bytes=${descriptor.size - 2}-${descriptor.size - 1}` }
            }), { store: nearEndStore, workerVersion: 'benchmark' });
            const nearEndBytes = new Uint8Array(await nearEnd.arrayBuffer());
            const nearEndMs = performance.now() - nearEndStarted;

            assertBenchmark(transferResult.verifiedBytes === descriptor.size, 'transfer did not verify all bytes');
            assertBenchmark(metadata.length === descriptor.blockHashes.length, 'metadata count differs from block count');
            assertBenchmark(full.status === 200 && fullBytes === descriptor.size, 'full local read was incomplete');
            assertBenchmark(nearEnd.status === 206 && nearEndBytes.byteLength === 2, 'near-end range was incomplete');
            assertBenchmark(nearEndGetBlockCalls === 1, 'near-end range addressed more than one block');
            assertBenchmark(nearEndListBlocksCalls === 0, 'near-end range enumerated metadata');

            const deleteStarted = performance.now();
            await store.deleteTitle('benchmark', bookId);
            const deleteMs = performance.now() - deleteStarted;
            await store.releaseLease(token);

            return {
              sizeMiB,
              blocks: descriptor.blockHashes.length,
              transferMs: round(transferMs),
              metadataMs: round(metadataMs),
              fullReadMs: round(fullReadMs),
              nearEndMs: round(nearEndMs),
              deleteMs: round(deleteMs),
              transferNetworkCalls: transferMetrics.networkCalls,
              transferGetBlockCalls: transferMetrics.getBlockCalls,
              transferListBlocksCalls: transferMetrics.listBlocksCalls,
              transferTouchedBlocks: transferMetrics.touchedBlocks.size,
              transferMaxAddressedBytes: transferMetrics.maxAddressedBytes,
              fullReadGetBlockCalls: fullReadCalls,
              nearEndGetBlockCalls,
              nearEndListBlocksCalls,
              nearEndTouchedBlocks: nearEndTouched.size
            };

            function assertBenchmark(condition, message) {
              if (!condition) throw new Error(message);
            }

            function round(value) {
              return Math.round(value * 10) / 10;
            }
          }, { descriptor: benchmarkDescriptor(sizeMiB), sizeMiB });
          results.push({ browser: browserName, ...result });
        }
        await context.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  for (const row of results) {
    assert.strictEqual(row.nearEndGetBlockCalls, 1);
    assert.strictEqual(row.nearEndListBlocksCalls, 0);
    assert.strictEqual(row.nearEndTouchedBlocks, 1);
    assert.ok(row.transferMaxAddressedBytes <= BLOCK_SIZE);
  }
  console.log('Synthetic generated-body transfer + IndexedDB benchmark (not network throughput)');
  console.table(results);
  console.log(JSON.stringify({ benchmark: 'offline-blocks-synthetic-body-idb', results }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
