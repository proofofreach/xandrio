// Failure cases, specified before implementation: identical retries cannot recover;
// a failed later request leaves short audio that restart adopts; exhausted retries
// or cancellation publish audio; inserted silence hides truncation; unavailable probes count as validation; a retry
// policy invalidates already verified audio or changes the narrator/text.
// Frame-limit recovery cases, specified before implementation: a typed worker
// failure bypasses alternate seeds; mixed short/frame failures reset the budget;
// exhausted or cancelled retries publish partial audio; unknown errors retry.
// Real HTTP app and real mastering/cache/restart. Speech service is a fixture.
// --baseline saves old-version verified audio; --reuse-baseline verifies reuse.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/nano-recovery/e2e');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = 'nano-recovery-fixture';

(async () => {
  await fs.mkdir(output, { recursive: true });
  const reuse = process.argv.includes('--reuse-baseline');
  const baselineFile = path.join(output, 'baseline.json');
  const baseline = reuse ? JSON.parse(await fs.readFile(baselineFile)) : null;
  const data = baseline?.data || await fs.mkdtemp(path.join(os.tmpdir(), 'nano-recovery-e2e-'));
  const cache = path.join(data, 'cache');
  await fs.mkdir(cache, { recursive: true });
  const cases = ['cached', 'recover', 'exhausted', 'http-error', 'padded', 'cancel', 'duration-probe', 'noise-probe',
    'frame-recover', 'frame-mixed', 'frame-exhausted', 'frame-cancel', 'unknown-error', 'invalid-request'];
  const textFor = id => `The ${id} passage continues through the quiet garden. Every sentence must remain present when the narrator finishes this short scene.`;
  const tail = 'The final scene closes quietly after everyone has returned home.';
  if (reuse) {
    assert(path.basename(data).startsWith('nano-recovery-e2e-'), 'Only reuse a fixture created by this script');
    for (const name of await fs.readdir(cache)) {
      if (cases.filter(id => id !== 'cached').some(id => name.startsWith(`${id}_`))) {
        await fs.rm(path.join(cache, name), { recursive: true, force: true });
      }
    }
    await fs.rm(path.join(data, 'generation-state.json'), { force: true });
  }
  {
    const books = {}, bookNarration = {};
    for (const id of cases) {
      const bookPath = path.join(cache, `${id}.xbook.json`);
      await fs.writeFile(bookPath, JSON.stringify({ _xbookVersion: 2,
        metadata: { title: id, language: 'en' },
        chapters: [{ id: 'one', title: 'One', type: 'chapter', text: textFor(id) + (id === 'padded' ? '' : `\n\n${tail}`) }] }));
      books[id] = { id, title: id, author: 'Fixture', path: bookPath, language: 'en', chapterCount: 1 };
      bookNarration[id] = { voiceId: 'moss-nano:Adam', fallbackPolicy: 'wait' };
    }
    await fs.writeFile(path.join(data, 'books.json'), JSON.stringify(books));
    await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ voice: 'kokoro:af_heart',
      premiumPrepEnabled: true, bookNarration,
      operatorPolicy: { version: 1, acknowledgedAt: new Date().toISOString(), unverifiedSourcesEnabled: false } }));
  }
  const audio = {};
  for (const [name, seconds] of [['short', 0.5], ['valid', 8]]) {
    const file = path.join(output, `${name}.wav`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `sine=frequency=220:duration=${seconds}:sample_rate=48000`, '-ac', '2', file]);
    audio[name] = await fs.readFile(file);
  }
  const shim = path.join(output, 'probe-shims'); await fs.mkdir(shim, { recursive: true });
  const ffmpeg = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  const ffprobe = execFileSync('which', ['ffprobe'], { encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(shim, 'ffprobe'), `#!/bin/sh\n[ "$NANO_TEST_PROBE_FAILURE" = duration ] && exit 1\nexec '${ffprobe.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(shim, 'ffmpeg'), `#!/bin/sh\nif [ "$NANO_TEST_PROBE_FAILURE" = noise ]; then\n case "$*" in *aspectralstats*) exit 1;; esac\nfi\nexec '${ffmpeg.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  const calls = [], results = [];
  let child, origin, log = '', cancellationClosed = false;
  const service = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true,"device":"cpu"}'); }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const id = cases.find(candidate => input.text.includes(`The ${candidate} passage`));
    calls.push({ id, ...input });
    if (['cancel', 'frame-cancel'].includes(id) && input.seed === 1235) {
      res.once('close', () => { cancellationClosed = true; }); return;
    }
    if (id?.startsWith('frame-') && (input.seed === 1234 && id !== 'frame-mixed'
        || id === 'frame-mixed' && input.seed === 1235 || id === 'frame-exhausted')) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Synthesis failed; no audio was published', code: 'NANO_FRAME_LIMIT' }));
    }
    if (['unknown-error', 'invalid-request'].includes(id)) {
      res.writeHead(id === 'invalid-request' ? 400 : 422, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Synthesis failed; no audio was published',
        code: id === 'invalid-request' ? 'NANO_FRAME_LIMIT' : 'UNKNOWN_FAILURE' }));
    }
    if (id === 'http-error' && calls.filter(call => call.id === id).length > 1) {
      res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end('{"error":"Synthesis failed; no audio was published"}');
    }
    const valid = input.text === tail || ['cached', 'duration-probe', 'noise-probe'].includes(id)
      || (id === 'recover' && input.seed === 1236) || (id === 'frame-recover' && input.seed === 1235)
      || (id === 'frame-mixed' && input.seed === 1236);
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(audio[valid ? 'valid' : 'short']);
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
  }
  function request(route, options = {}) {
    return fetch(origin + route, { ...options, headers: { Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json' }, signal: options.signal || AbortSignal.timeout(30000) });
  }
  async function until(probe, label) {
    for (let i = 0; i < 200; i++) { const value = await probe(); if (value) return value; await delay(50); }
    throw new Error(`Timed out: ${label}`);
  }
  async function start(probeFailure = '') {
    await stop();
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    const engine = `http://127.0.0.1:${service.address().port}`;
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`, NANO_TEST_PROBE_FAILURE: probeFailure,
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, CACHE_DIR: cache,
      XANDRIO_TOKEN: token, XANDRIO_VOICE_PROVIDERS: 'kokoro,moss-nano',
      MOSS_NANO_ENABLED: 'true', MOSS_NANO_AUTO_START: 'false', MOSS_NANO_TTS_URL: engine,
      KOKORO_AUTO_START: 'false', KOKORO_TTS_URL: engine, CHATTERBOX_AUTO_START: 'false',
      XANDRIO_RATE_LIMIT_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    await until(async () => { try { return (await request('/api/voices')).ok; } catch { return false; } }, 'app startup');
  }
  const filesFor = async id => (await fs.readdir(cache)).filter(name => name.startsWith(`${id}_tts`) && /\.mp3(?:\.narration-artifact\.json)?$/.test(name));
  const status = async id => (await request(`/api/chunks/${id}/0/status?tier=premium`)).json();
  async function check(name, fn) {
    try { const evidence = await fn(); results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  try {
    await start();
    await check('verified seed-1234 audio survives restart without synthesis or rewrite', async () => {
      const response = await request('/api/audio/cached/0'); assert.equal(response.status, 200); await response.arrayBuffer();
      const names = await filesFor('cached'); assert(names.some(n => /_chunk0\.mp3$/.test(n)));
      const snapshot = {};
      for (const name of names) snapshot[name] = { hash: hash(await fs.readFile(path.join(cache, name))),
        ...(!name.endsWith('.json') ? { mtimeMs: (await fs.stat(path.join(cache, name))).mtimeMs } : {}) };
      if (baseline) { assert.deepEqual(snapshot, baseline.files); assert.equal(calls.filter(c => c.id === 'cached').length, 0); }
      await fs.writeFile(baselineFile, JSON.stringify({ data, files: snapshot }, null, 2));
      const before = calls.length; await start();
      const cached = await request('/api/audio/cached/0'); assert.equal(cached.status, 200); await cached.arrayBuffer();
      assert.equal(calls.length, before);
      for (const name of names) assert.equal(hash(await fs.readFile(path.join(cache, name))), snapshot[name].hash);
      return { oldVersionBaseline: Boolean(baseline), unchangedFiles: names.length };
    });
    if (!process.argv.includes('--baseline')) {
      await check('full chapter recovers with three different seeds and unchanged text/voice', async () => {
        const response = await request('/api/audio/recover/0'); assert.equal(response.status, 200); await response.arrayBuffer();
        const used = calls.filter(c => c.id === 'recover');
        assert.deepEqual(used.map(c => c.seed), [1234, 1235, 1236]);
        assert(used.every(c => c.voice === 'Adam' && c.text === textFor('recover')));
        const progress = await status('recover'); assert.equal(progress.readyChunks, progress.totalChunks);
        return { seeds: used.map(c => c.seed), readyChunks: progress.readyChunks };
      });
      for (const id of ['frame-recover', 'frame-mixed']) await check(`${id} completes with one shared seed budget`, async () => {
        const response = await request(`/api/audio/${id}/0`); assert.equal(response.status, 200); await response.arrayBuffer();
        const used = calls.filter(c => c.id === id);
        assert.deepEqual(used.map(c => c.seed), id === 'frame-recover' ? [1234, 1235] : [1234, 1235, 1236]);
        assert(used.every(c => c.voice === 'Adam' && c.text === textFor(id)));
        const progress = await status(id); assert.equal(progress.readyChunks, progress.totalChunks);
        const responseAudio = await request(`/api/chunks/${id}/0/0?tier=premium`);
        assert.equal(responseAudio.status, 200); assert.equal(responseAudio.headers.get('x-voice-id'), 'moss-nano:Adam');
        await responseAudio.arrayBuffer();
        return { seeds: used.map(c => c.seed), readyChunks: progress.readyChunks };
      });
      for (const id of ['frame-exhausted', 'unknown-error', 'invalid-request']) await check(`${id} fails closed with bounded requests`, async () => {
        const response = await request(`/api/audio/${id}/0`); assert.equal(response.status, 500); await response.text();
        assert.deepEqual(calls.filter(c => c.id === id).map(c => c.seed), id === 'frame-exhausted' ? [1234, 1235, 1236] : [1234]);
        assert(!(await filesFor(id)).some(name => /_chunk0\.mp3(?:\.narration-artifact\.json)?$/.test(name)));
        await start(); await status(id);
        assert(!(await filesFor(id)).some(name => /_chunk0\.mp3(?:\.narration-artifact\.json)?$/.test(name)));
        return { rejectedFirstChunkAbsent: true };
      });
      for (const id of ['exhausted', 'http-error', 'padded']) await check(`${id} leaves no rejected audio for restart to adopt`, async () => {
        const response = await request(`/api/audio/${id}/0`); assert.equal(response.status, 500); await response.text();
        assert(!(await filesFor(id)).some(name => /_chunk0\.mp3(?:\.narration-artifact\.json)?$/.test(name)));
        await start(); const progress = await status(id);
        assert(!(await filesFor(id)).some(name => /_chunk0\.mp3(?:\.narration-artifact\.json)?$/.test(name)));
        return { readyChunksAfterRestart: progress.readyChunks, rejectedFirstChunkAbsent: true };
      });
      for (const id of ['cancel', 'frame-cancel']) await check(`${id}: pause aborts a later seed and removes rejected audio`, async () => {
        cancellationClosed = false;
        const response = await request(`/api/premium-prep/${id}/start`, { method: 'POST', body: '{"fromChapter":0}' }); assert(response.ok);
        await until(() => calls.some(c => c.id === id && c.seed === 1235), 'second seed');
        assert((await request(`/api/premium-prep/${id}/pause`, { method: 'POST', body: '{}' })).ok);
        await until(() => cancellationClosed, 'worker request cancelled');
        await until(async () => !(await filesFor(id)).some(name => /_chunk0\.mp3(?:\.narration-artifact\.json)?$/.test(name)), 'invalid output cleanup');
        assert.deepEqual(calls.filter(call => call.id === id).map(call => call.seed), [1234, 1235]);
        return { workerCancelled: true };
      });
      for (const probe of ['duration', 'noise']) await check(`${probe} probe failure cannot publish Nano audio`, async () => {
        await start(probe);
        const id = `${probe}-probe`; const response = await request(`/api/audio/${id}/0`);
        assert.equal(response.status, 500); await response.text(); assert.deepEqual(await filesFor(id), []);
      });
    }
  } finally {
    await stop(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    const report = { checkedAt: new Date().toISOString(), data, passed: results.every(r => r.passed), results, calls };
    await fs.writeFile(path.join(output, process.argv.includes('--baseline') ? 'baseline-report.json' : 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(output, 'app.log'), log);
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
