const assert = require('assert');
const fs = require('fs').promises;
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(origin, output, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy:\n${output()}`);
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-startup-bound-'));
  const dataDir = path.join(root, 'data');
  const cacheDir = path.join(root, 'cache');
  await fs.mkdir(dataDir);
  await fs.mkdir(cacheDir);
  const books = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    `book-${index}`,
    {
      id: `book-${index}`,
      title: `Book ${index}`,
      path: path.join(cacheDir, `book-${index}.epub`),
      chapterCount: 1,
      chapterDurations: [60],
      totalDuration: 60,
      audioGenerationState: 'partial'
    }
  ]));
  await fs.writeFile(path.join(dataDir, 'books.json'), JSON.stringify(books));

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      CACHE_DIR: cacheDir,
      XANDRIO_TOKEN: 'startup-bound-token',
      XANDRIO_PREGENERATE_ON_IMPORT: 'true',
      KOKORO_AUTO_START: 'false',
      CHATTERBOX_AUTO_START: 'false',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    await waitForHealth(origin, () => output);
    await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(`${origin}/api/admin/diagnostics`, {
      headers: { Authorization: 'Bearer startup-bound-token' }
    });
    assert.strictEqual(response.status, 200);
    const diagnostics = await response.json();
    assert.strictEqual(diagnostics.queue.active, 0);
    assert.strictEqual(diagnostics.queue.queued, 0);
    console.log('  ✓ 1,000 library titles create zero startup narration work');
    console.log('\n1 passed, 0 failed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`  ✗ ${error.stack || error.message}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
});
