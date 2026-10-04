// Failure matrix written before production code: seed exhaustion must recover by
// exact source subdivision; failed leaves cannot hide behind long siblings/padding;
// recursion shares a budget; unknown failures never split; cancellation, deadlines,
// probes, joins and process death cannot expose unvalidated logical output; old
// verified audio survives. These are real-app HTTP/E2E tests with a speech fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/nano-adaptive-recovery/e2e');
const token = 'nano-adaptive-fixture';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const sentences = ['Cedar branches swayed above the old road. ', 'Mara walked carefully beside the river. ', 'Silver clouds drifted toward the mountains.'];
const original = sentences.join('');
const recursive = 'Cedar branches swayed above the old road while Mara walked carefully beside the river and silver clouds drifted toward the distant mountains';
const unicode = '雪が静かに降り積もる山道を旅人たちはゆっくり歩き続けました。遠くの村から聞こえる鐘の音が冷たい空気の中に響き渡りました。';
(async () => {
  await fs.mkdir(output, { recursive: true });
  const results = [], calls = [], fixtures = {};
  for (const [name, source] of Object.entries({ short: 'sine=frequency=220:duration=0.1:sample_rate=24000',
    a: 'sine=frequency=240:duration=2:sample_rate=24000', b: 'sine=frequency=400:duration=2:sample_rate=24000',
    c: 'sine=frequency=680:duration=2:sample_rate=24000', long: 'sine=frequency=240:duration=8:sample_rate=24000',
    static: 'anoisesrc=color=white:amplitude=0.25:duration=5:sample_rate=24000' })) {
    const file = path.join(output, `${name}.wav`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-ac', '1', file]);
    fixtures[name] = await fs.readFile(file);
  }
  const shim = path.join(output, 'shims'); await fs.mkdir(shim, { recursive: true });
  const realFfmpeg = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  const realFfprobe = execFileSync('which', ['ffprobe'], { encoding: 'utf8' }).trim();
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  await fs.writeFile(path.join(shim, 'ffmpeg'), `#!/bin/sh\ncase "$*" in\n *' -f concat '*)\n  [ "$NANO_E2E_FAULT" = join ] && exit 1\n  touch "$NANO_E2E_JOINED";;\n *aspectralstats*) [ "$NANO_E2E_FAULT" = noise ] && exit 1;;\nesac\nexec ${quote(realFfmpeg)} "$@"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(shim, 'ffprobe'), `#!/bin/sh\n[ "$NANO_E2E_FAULT" = duration ] && exit 1\nif [ "$NANO_E2E_FAULT" = final-probe ] && [ -f "$NANO_E2E_JOINED" ]; then exit 1; fi\nexec ${quote(realFfprobe)} "$@"\n`, { mode: 0o755 });
  // Test-only dependency overrides exercise real HTTP publication failures and
  // keep the production deadline path fast. No serving configuration is added.
  const preload = path.join(output, 'deadline.cjs');
  await fs.writeFile(preload, `
if (process.env.NANO_E2E_FAULT.startsWith('crash-cleanup')) {
 const fs = require('node:fs'), path = require('node:path');
 const stale = path.join(process.env.CACHE_DIR, '.nano-recovery-' + process.pid + '-stale');
 fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'old.wav'), 'stale fixture');
 const old = new Date(Date.now() - 600000); fs.utimesSync(stale, old, old);
}
if (process.env.NANO_E2E_FAULT === 'crash-cleanup-nested') {
 const Q = require(${JSON.stringify(path.join(root, 'lib/tts-queue'))}); const enqueue = Q.prototype.enqueue;
 Q.prototype.enqueue = function (params) { return enqueue.call(this, { ...params, outputPath: require('node:path').join(this.cacheDir, 'voice-samples/fixture.mp3') }); };
}
if (['enqueue-outside', 'enqueue-cancel'].includes(process.env.NANO_E2E_FAULT)) {
 const Q = require(${JSON.stringify(path.join(root, 'lib/tts-queue'))}); const enqueue = Q.prototype.enqueue;
 Q.prototype.enqueue = async function (params) {
  const id = await enqueue.call(this, { ...params, outputPath: require('node:path').resolve(process.env.CACHE_DIR, '../escaped.mp3'), reuseExistingOutput: process.env.NANO_E2E_FAULT !== 'enqueue-cancel' });
  if (process.env.NANO_E2E_FAULT === 'enqueue-cancel') this.cancel(id);
  return id;
 };
}
if (['outside-cache', 'symlink-escape'].includes(process.env.NANO_E2E_FAULT)) {
 const Q = require(${JSON.stringify(path.join(root, 'lib/tts-queue'))}); const original = Q.prototype._generateHttpTTS;
 Q.prototype._generateHttpTTS = function (...args) { args[2] = require('node:path').resolve(process.env.CACHE_DIR, process.env.NANO_E2E_FAULT === 'outside-cache' ? '../escaped.mp3' : 'escape/escaped.mp3'); return original.apply(this, args); };
}
if (process.env.NANO_E2E_FAULT === 'marker-false') require(${JSON.stringify(path.join(root, 'lib/narration-artifact-cache'))}).NarrationArtifactCache.prototype.publishVerified = async () => false;
if (process.env.NANO_E2E_FAULT === 'recipe-failure') require(${JSON.stringify(path.join(root, 'lib/tts-queue'))}).prototype._artifactDescriptor = () => { throw new Error('Injected recipe failure'); };
if (process.env.NANO_E2E_FAULT.includes('deadline')) try { const p = require(${JSON.stringify(path.join(root, 'lib/nano-synthesis-recovery'))}); p.RECOVERY_LIMITS.deadlineMs = 1000; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }\n`);
  let mode = '', sourceText = original, child, origin, data, cache, log = '', closed = false, held = false;
  const service = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true,"device":"cpu"}'); }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (mode === 'unicode' && !calls.some(call => call.mode === mode)) sourceText = input.text; // Prepared text may add final punctuation.
    const isRoot = input.text === sourceText;
    const call = { mode, ...input, valid: false }; calls.push(call);
    if (mode === 'unknown') { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end('{"code":"UNKNOWN_FAILURE"}'); }
    if (mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('not audio'); }
    if (mode === 'frame' && isRoot) { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end('{"code":"NANO_FRAME_LIMIT"}'); }
    const leafIndex = sourceText.indexOf(input.text);
    if (['cancel', 'kill', 'crash-cleanup', 'crash-cleanup-nested', 'deadline', 'body-deadline'].includes(mode) && !isRoot && leafIndex > 0) {
      held = true; res.once('close', () => { closed = true; });
      if (mode === 'body-deadline') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.write(fixtures.a.subarray(0, 44)); }
      return;
    }
    let audio = fixtures.short;
    if (mode === 'baseline' || ['duration', 'noise', 'first-kill'].includes(mode)) { audio = fixtures.long; call.valid = true; }
    else if (mode === 'static' && isRoot) audio = fixtures.static;
    else if (!isRoot && mode !== 'exhausted' && (!['recursive', 'budget'].includes(mode) || input.text.trim().length <= 48)) {
      if (mode === 'bad-child' && leafIndex > 0 || mode === 'budget' && input.seed !== 1234) audio = fixtures.short;
      else {
        audio = mode === 'bad-child' ? fixtures.long : fixtures[leafIndex === 0 ? 'a' : leafIndex < sentences[0].length + sentences[1].length ? 'b' : 'c'];
        call.valid = true;
      }
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(audio);
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  async function until(probe, label, count = 300) {
    for (let i = 0; i < count; i++) { const result = await probe(); if (result) return result; await delay(50); }
    throw new Error(`Timed out: ${label}`);
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exit = once(child, 'exit'); child.kill(signal);
    await Promise.race([exit, delay(2000)]);
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exit; }
  }
  const request = (route, options = {}) => fetch(origin + route, { ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(25000) });
  async function start(restart = false, format = 'mp3') {
    await stop(); held = closed = false;
    if (!restart) {
      data = await fs.mkdtemp(path.join(os.tmpdir(), 'nano-adaptive-e2e-')); cache = path.join(data, 'cache'); await fs.mkdir(cache);
      if (mode === 'crash-cleanup-nested') await fs.mkdir(path.join(cache, 'voice-samples'), { recursive: true });
      if (mode.startsWith('enqueue-')) await fs.writeFile(path.join(data, 'escaped.mp3'), fixtures.long);
      if (mode === 'symlink-escape') { const external = path.join(data, 'external'); await fs.mkdir(external); await fs.symlink(external, path.join(cache, 'escape')); }
      const bookPath = path.join(cache, 'fixture.xbook.json');
      await fs.writeFile(bookPath, JSON.stringify({ _xbookVersion: 2, metadata: { title: 'Fixture', language: 'en' }, chapters: [{ id: 'one', title: 'One', type: 'chapter', text: sourceText }] }));
      await fs.writeFile(path.join(data, 'books.json'), JSON.stringify({ fixture: { id: 'fixture', title: 'Fixture', author: 'Fixture', path: bookPath, language: 'en', chapterCount: 1 } }));
      await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ voice: 'kokoro:af_heart', premiumPrepEnabled: true,
        bookNarration: { fixture: { voiceId: 'moss-nano:Adam', fallbackPolicy: 'wait' } }, operatorPolicy: { version: 1, acknowledgedAt: new Date().toISOString(), unverifiedSourcesEnabled: false } }));
    }
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    origin = `http://127.0.0.1:${port}`; const engine = `http://127.0.0.1:${service.address().port}`;
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`, NODE_OPTIONS: `--require=${preload}`,
      NANO_E2E_FAULT: mode, NANO_E2E_JOINED: path.join(data, 'joined'),
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, CACHE_DIR: cache, XANDRIO_TOKEN: token,
      XANDRIO_VOICE_PROVIDERS: 'kokoro,moss-nano', MOSS_NANO_ENABLED: 'true', MOSS_NANO_AUTO_START: 'false',
      MOSS_NANO_TTS_URL: engine, MOSS_NANO_MASTERING_GAIN_DB: '0', MOSS_NANO_TTS_OUTPUT_FORMAT: format,
      KOKORO_AUTO_START: 'false', KOKORO_TTS_URL: engine, CHATTERBOX_AUTO_START: 'false', XANDRIO_RATE_LIMIT_DISABLED: 'true'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    await until(async () => { try { return (await request('/api/voices')).ok; } catch { return false; } }, 'app startup');
  }
  const files = async () => (await fs.readdir(cache)).filter(n => /^fixture_tts.*_chunk0\.(mp3|wav)(\.narration-artifact\.json)?$/.test(n));
  const status = async () => (await request('/api/chunks/fixture/0/status?tier=premium')).json();
  async function absent() { assert.deepEqual(await files(), []); await until(async () => !(await fs.readdir(cache)).some(n => n.startsWith('.nano-recovery-')), 'scratch cleanup'); }
  async function check(name, fn) {
    const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
    if (only && !only.some(label => name.startsWith(label + ':'))) return;
    try { const evidence = await fn(); results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
    catch (e) { results.push({ name, passed: false, error: e.message }); console.error(`FAIL ${name}: ${e.message}`); }
    finally { await stop(); }
  }
  try {
    await check('old verified first take survives upgrade and restart', async () => {
      mode = 'baseline'; sourceText = original;
      const baselineFile = path.join(output, 'baseline.json');
      const old = process.argv.includes('--reuse-baseline') ? JSON.parse(await fs.readFile(baselineFile)) : null;
      if (old) { assert(path.basename(old.data).startsWith('nano-adaptive-e2e-')); data = old.data; cache = path.join(data, 'cache'); }
      await start(Boolean(old));
      const response = await request('/api/audio/fixture/0'); assert.equal(response.status, 200); await response.arrayBuffer();
      const snapshot = {};
      for (const name of await files()) snapshot[name] = { hash: hash(await fs.readFile(path.join(cache, name))), ...(!name.endsWith('.json') ? { mtime: (await fs.stat(path.join(cache, name))).mtimeMs } : {}) };
      if (old) { assert.deepEqual(snapshot, old.files); assert.equal(calls.length, 0); }
      await fs.writeFile(baselineFile, JSON.stringify({ data, files: snapshot }, null, 2));
      const before = calls.length; await start(true); const cached = await request('/api/audio/fixture/0'); assert.equal(cached.status, 200); await cached.arrayBuffer(); assert.equal(calls.length, before);
      return { preservedFiles: Object.keys(snapshot).length, oldVersion: Boolean(old) };
    });
    if (!process.argv.includes('--baseline')) {
      for (const scenario of ['short', 'frame', 'static', 'recursive', 'unicode', 'wav']) await check(`${scenario}: exact source recovery, one pause and one mastering pass`, async () => {
        mode = scenario; sourceText = mode === 'recursive' ? recursive : mode === 'unicode' ? unicode : original;
        const offset = calls.length; await start(false, scenario === 'wav' ? 'wav' : 'mp3');
        const response = await request('/api/audio/fixture/0'); assert.equal(response.status, 200); await response.arrayBuffer();
        const used = calls.slice(offset); assert(used.length > 3 && used.length <= 15); assert(used.every(c => c.voice === 'Adam'));
        assert.deepEqual(used.filter(c => c.text === sourceText).map(c => c.seed), [1234, 1235, 1236]);
        const valid = used.filter(c => c.valid); assert(valid.every(c => c.seed === 1235), 'new fragment starts on alternate seed'); assert.equal(valid.map(c => c.text).join(''), sourceText);
        const progress = await status(); assert.equal(progress.totalChunks, 1); assert.equal(progress.readyChunks, 1);
        const names = await files(); assert(names.some(n => n.endsWith('.narration-artifact.json')));
        const name = names.find(n => /\.(mp3|wav)$/.test(n)); const file = path.join(cache, name);
        const metadata = JSON.parse(execFileSync(realFfprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
        assert.equal(metadata.streams[0].channels, 1); assert.equal(Number(metadata.streams[0].sample_rate), 24000);
        const duration = Number(metadata.format.duration); assert(Math.abs(duration - (valid.length * 2 + 5)) < 0.2, `duration ${duration}`);
        const pcm = execFileSync(realFfmpeg, ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 8e6 });
        const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
        for (let i = 0; i < valid.length; i++) {
          const start = Math.round((i * 2 + 0.5) * 24000); let crossings = 0, peak = 0;
          for (let j = start; j < start + 12000; j++) { peak = Math.max(peak, Math.abs(samples[j])); if (samples[j] <= 0 && samples[j + 1] > 0) crossings++; }
          const sourceOffset = sourceText.indexOf(valid[i].text); const frequency = sourceOffset === 0 ? 240 : sourceOffset < sentences[0].length + sentences[1].length ? 400 : 680;
          assert(Math.abs(crossings * 2 - frequency) < 5, 'source order changed'); assert(peak > 0.11 && peak < 0.14, `gain applied incorrectly ${peak}`);
        }
        assert(!(await fs.readdir(cache)).some(n => n.startsWith('.nano-recovery-')));
        return { attempts: used.length, leaves: valid.length, duration, format: scenario === 'wav' ? 'wav' : 'mp3' };
      });
      for (const scenario of ['bad-child', 'exhausted', 'budget', 'enqueue-outside', 'enqueue-cancel', 'outside-cache', 'symlink-escape', 'marker-false', 'recipe-failure', 'unknown', 'malformed', 'duration', 'noise', 'join', 'final-probe']) await check(`${scenario}: failure cannot publish or be adopted`, async () => {
        mode = scenario; sourceText = mode === 'budget' ? recursive : original; const before = calls.length; await start();
        const response = await request('/api/audio/fixture/0'); assert.equal(response.status, 500); const error = await response.text();
        const used = calls.slice(before);
        if (mode.startsWith('enqueue-')) {
          assert.equal(used.length, 0);
          await delay(100);
          assert.equal(hash(await fs.readFile(path.join(data, 'escaped.mp3'))), hash(fixtures.long), 'external audio changed');
          assert.equal(await fs.stat(path.join(data, 'escaped.mp3.narration-artifact.json')).then(() => true, () => false), false, 'external marker written');
        }
        if (['outside-cache', 'symlink-escape'].includes(mode)) {
          assert.equal(used.length, 0, 'out-of-cache request reached synthesis');
          for (const file of [path.join(data, 'escaped.mp3'), path.join(data, 'external/escaped.mp3')]) assert.equal(await fs.stat(file).then(() => true, () => false), false, 'wrote outside cache');
        }
        assert(used.length <= 15); if (mode === 'budget') assert.equal(used.length, 15); await absent();
        if (['unknown', 'malformed', 'duration', 'noise'].includes(mode)) assert.equal(used.length, 1);
        if (['bad-child', 'exhausted'].includes(mode)) assert(used.length > 3);
        await start(true); const progress = await status(); assert.equal(progress.readyChunks, 0); await absent();
        return { attempts: used.length, error: error.slice(0, 160) };
      });
      for (const scenario of ['deadline', 'body-deadline']) await check(`${scenario}: a hung fragment is bounded and cleaned`, async () => {
        mode = scenario; sourceText = original; await start(); const before = calls.length, time = Date.now(), logOffset = log.length;
        const response = await request('/api/audio/fixture/0'); assert.equal(response.status, 500); const error = await response.text();
        assert.match(log.slice(logOffset), /recovery deadline exceeded/i); assert(Date.now() - time < 5000); assert(held); await until(() => closed, 'body abort'); await absent();
        return { attempts: calls.length - before, elapsedMs: Date.now() - time };
      });
      for (const scenario of ['crash-cleanup', 'crash-cleanup-nested']) await check(`${scenario}: removes dead-process scratch and preserves active owners`, async () => {
        mode = scenario; sourceText = original; await start();
        await until(async () => !(await fs.readdir(cache)).includes(`.nano-recovery-${child.pid}-stale`), 'same PID from an earlier process removed');
        const activeName = `.nano-recovery-${process.pid}-active`;
        const activeDir = path.join(cache, activeName); await fs.mkdir(activeDir);
        await fs.writeFile(path.join(activeDir, 'keep.wav'), fixtures.a);
        const protectedFile = path.join(cache, 'protected.mp3'); await fs.writeFile(protectedFile, fixtures.long);
        const pending = request('/api/audio/fixture/0').catch(() => null);
        await until(() => held, 'later fragment before process death');
        const abandoned = (await fs.readdir(cache)).filter(name => name.startsWith('.nano-recovery-') && name !== activeName);
        assert.equal(abandoned.length, 1); const before = calls.length;
        await stop('SIGKILL'); await pending;
        assert.equal((await fs.stat(path.join(cache, abandoned[0]))).isDirectory(), true, 'must reproduce an orphan');
        await start(true);
        await until(async () => !(await fs.readdir(cache)).some(name => abandoned.includes(name)), 'startup orphan cleanup');
        assert.equal(hash(await fs.readFile(path.join(activeDir, 'keep.wav'))), hash(fixtures.a));
        assert.equal(hash(await fs.readFile(protectedFile)), hash(fixtures.long));
        assert.deepEqual(await files(), []); assert.equal((await status()).readyChunks, 0);
        return { removedOrphans: abandoned.length, activeOwnerPreserved: true, reusedPidCleaned: true, existingAudioPreserved: true, resumedRequests: calls.length - before };
      });
      for (const scenario of ['cancel', 'kill']) await check(`${scenario}: an interrupted recovery is never adopted`, async () => {
        mode = scenario; sourceText = original; await start();
        assert((await request('/api/premium-prep/fixture/start', { method: 'POST', body: '{"fromChapter":0}' })).ok);
        await until(() => held, 'later fragment'); const before = calls.length;
        assert.deepEqual(await files(), [], 'unvalidated logical output became visible');
        assert((await request('/api/premium-prep/fixture/pause', { method: 'POST', body: '{}' })).ok);
        if (scenario === 'kill') await stop('SIGKILL');
        else { await until(() => closed, 'cancel worker request'); await until(async () => !(await fs.readdir(cache)).some(n => n.startsWith('.nano-recovery-')), 'scratch cleanup'); }
        await start(true); const progress = await status(); assert.equal(progress.readyChunks, 0); assert.deepEqual(await files(), []);
        await delay(500); assert.equal(calls.length, before, 'pause intent lost');
        return { pausedAcrossRestart: true, noPartialAdoption: true };
      });
    }
  } finally {
    await stop(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    const report = { checkedAt: new Date().toISOString(), passed: results.every(r => r.passed), results, calls };
    await fs.writeFile(path.join(output, process.argv.includes('--baseline') ? 'baseline-report.json' : 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(output, 'app.log'), log); if (!report.passed) process.exitCode = 1;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
