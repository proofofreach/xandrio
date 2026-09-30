// Failure modes: configuration writes are unbounded; POST and DELETE use
// different budgets; rejected writes reach disk; members exhaust the admin
// budget; status reads are blocked; a completed window never recovers.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { registerPreferencesRoutes } = require('../lib/routes/preferences-routes');

(async () => {
  const output = path.resolve(__dirname, '../output/playback-processing');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-configuration-rate-'));
  const file = path.join(temp, 'annas.json');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'fixture', role: req.headers['x-fixture-role'] === 'member' ? 'member' : 'admin' };
    next();
  });
  let writes = 0;
  registerPreferencesRoutes(app, {
    annasAuthFile: file,
    configurationRateLimitMax: 2,
    configurationRateLimitWindowMs: 1000,
    getAnnasConfig: () => fsSync.existsSync(file) ? JSON.parse(fsSync.readFileSync(file, 'utf8')) : {},
    validateAnnasOrigin: async () => 'https://annas-archive.li',
    saveJSON: async (target, value) => { writes++; await fs.writeFile(target, JSON.stringify(value)); }
  });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = [];
  let passed = false;
  async function request(method, pathname = '/api/annas/configure', role = 'admin') {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-fixture-role': role },
      body: method === 'POST' ? JSON.stringify({ secretKey: 'fixture-key' }) : undefined
    });
    const item = { method, pathname, role, status: response.status, retryAfter: response.headers.get('retry-after') };
    evidence.push(item); await response.arrayBuffer(); return item;
  }
  try {
    for (let i = 0; i < 4; i++) assert.equal((await request('POST', undefined, 'member')).status, 403);
    assert.equal(writes, 0);
    assert.equal((await request('POST')).status, 200);
    assert(fsSync.existsSync(file));
    assert.equal((await request('DELETE')).status, 200);
    assert(!fsSync.existsSync(file));
    const blocked = await request('POST');
    assert.equal(blocked.status, 429, 'configuration writes must share a bounded budget');
    assert(Number(blocked.retryAfter) > 0);
    assert.equal(writes, 1); assert(!fsSync.existsSync(file), 'a rejected save must not touch disk');
    assert.equal((await request('DELETE')).status, 429);
    assert.equal((await request('GET', '/api/annas/status')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await request('POST')).status, 200);
    assert.equal(writes, 2); passed = true;
    console.log('PASS configuration writes are bounded, authorized, and recover after the rate window');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `${process.env.CONFIG_RATE_PHASE || 'configuration-rate'}.json`), JSON.stringify({ passed, writes, requests: evidence }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
