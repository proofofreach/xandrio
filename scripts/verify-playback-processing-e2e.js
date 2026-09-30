const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { chromium, webkit } = require('playwright');
const { createBookDocument } = require('../lib/book-document');
const { buildChapterTransition, remapBookPositions } = require('../lib/chapter-reprocess');
const { createChapterAudioReconciler } = require('../lib/chapter-audio-reconcile');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-processing');
const results = [];
const phase = process.env.BUG_AUDIT_PHASE || 'verification';
const browserName = process.env.BUG_AUDIT_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(browserName), 'BUG_AUDIT_BROWSER must be chromium or webkit');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function check(name, fn) {
  if (process.env.BUG_AUDIT_FILTER && !name.includes(process.env.BUG_AUDIT_FILTER)) return;
  try {
    const evidence = await fn();
    results.push({ name, passed: true, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
function wav(seconds) {
  const samples = seconds * 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 0.1)), 44 + i * 2);
  return bytes;
}
async function makeEpub(dir, name, body) {
  const source = path.join(dir, name);
  await fs.mkdir(path.join(source, 'META-INF'), { recursive: true });
  await fs.writeFile(path.join(source, 'mimetype'), 'application/epub+zip');
  await fs.writeFile(path.join(source, 'META-INF/container.xml'), '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  await fs.writeFile(path.join(source, 'book.opf'), '<?xml version="1.0"?><package version="2.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">audit</dc:identifier><dc:title>Synthetic audit</dc:title><dc:creator>Fixture</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
  await fs.writeFile(path.join(source, 'chapter.xhtml'), `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>${body}</p><p>${'Synthetic narration preserves the complete source text. '.repeat(50)}</p></body></html>`);
  const target = path.join(dir, `${name}.epub`);
  execFileSync('zip', ['-q', '-X0', target, 'mimetype'], { cwd: source });
  execFileSync('zip', ['-q', '-Xr', target, 'META-INF', 'book.opf', 'chapter.xhtml'], { cwd: source });
  return target;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-bug-audit-'));
  let browser, server, context;
  const gates = new Map();
  const timelines = new Map();
  const allGates = new Set();
  try {
    const document = createBookDocument({ log: { log() {}, warn() {}, error() {} } });
    async function narration(name, body) {
      const source = await makeEpub(temp, name, body);
      const chapters = await document.getChaptersCached(source);
      const reloaded = await createBookDocument().getChaptersCached(source);
      assert.deepEqual(reloaded, chapters, 'disk cache must preserve extracted narration');
      return chapters.map(chapter => chapter.text).join('\n');
    }
    await check('processing: preserve apostrophized names', async () => {
      const text = await narration('names', "O'Reilly met D'Souza and O’Reilly. It'scalled a meeting.");
      assert(text.includes("O'Reilly met D'Souza and O’Reilly."), text.slice(0, 100));
      assert(text.includes("It's called"), 'retain supported fused-contraction repair');
      return { retained: "O'Reilly, D'Souza, O’Reilly" };
    });
    await check('processing: preserve named accents and symbols', async () => {
      const expected = 'Émile visited a café. Α α cost €5 and ½ a pound.';
      const text = await narration('named-accents', '&Eacute;mile visited a caf&eacute;. &Alpha; &alpha; cost &euro;5 and &frac12; a pound.');
      assert(text.includes(expected), text.slice(0, 150));
      return { retained: expected };
    });
    await check('processing: preserve authored Unicode joiners', async () => {
      const expected = 'می\u200cروم and क्\u200dष and 👩\u200d🔬.';
      const text = await narration('joiners', expected);
      assert(text.includes(expected), text.slice(0, 150));
      return { retained: expected };
    });
    await check('processing: preserve words across inline Unicode markup', async () => {
      const expected = 'café and Émile and 中文 and HELLO.';
      const text = await narration('inline-unicode', 'caf<em>é</em> and <span>É</span>mile and 中<b>文</b> and H<strong>ELLO</strong>.');
      assert(text.includes(expected), text.slice(0, 150));
      return { retained: expected };
    });
    await check('processing: preserve literal escaped text', async () => {
      const text = await narration('entities', 'Print &lt;variable&gt; and &amp;lt;label&amp;gt; and &amp;nbsp; literally.');
      assert(text.includes('<variable>'), text.slice(0, 100));
      assert(text.includes('&lt;label&gt;') && text.includes('&nbsp;'), text.slice(0, 100));
      return { retained: '<variable>, &lt;label&gt;, &nbsp;' };
    });
    await check('processing: tolerate invalid numeric entities', async () => {
      const text = await narration('invalid-entity', 'Before &#x110000; after &#999999999999; end.');
      assert(text.includes('Before') && text.includes('after') && text.includes('end.'), 'surrounding authored text survives');
      assert(text.includes('\uFFFD'), 'invalid Unicode scalar is replaced visibly');
      return { surroundingTextRetained: true };
    });
    await check('processing: rebuild uses time when character offset is null', async () => {
      const first = 'First part of the narrative. '.repeat(50);
      const second = 'Second part of the narrative. '.repeat(50);
      const transition = buildChapterTransition(
        [{ text: first, estimatedDuration: 100 }, { text: second, estimatedDuration: 100 }],
        [{ text: `${first} ${second}`, estimatedDuration: 200 }]
      );
      const store = { users: { reader: { audit: { chapterIndex: 1, timestamp: 50, characterOffset: null, chunkIndex: 2, chunkTime: 4 } } } };
      const file = path.join(temp, 'positions.json');
      await fs.writeFile(file, JSON.stringify(remapBookPositions(store, 'audit', transition, 'rebuilt')));
      const position = JSON.parse(await fs.readFile(file)).users.reader.audit;
      assert(position.timestamp > 140 && position.timestamp < 160, JSON.stringify(position));
      assert.equal(position.positionApproximate, true);
      assert.equal(position.chunkIndex, undefined);
      return position;
    });
    for (const variant of ['current', 'legacy', 'partial-copy']) await check(variant === 'legacy'
      ? 'processing: recover promoted audio from a legacy rebuild journal'
      : variant === 'partial-copy'
        ? 'processing: interrupted recovery copy never becomes a valid stage'
        : 'processing: recover already-promoted audio after a rebuild crash', async () => {
      const dir = path.join(temp, `${variant}-promoted-recovery`); await fs.mkdir(dir);
      const chapters = [{ text: 'Opening part. Closing part.', estimatedDuration: 10 }, { text: 'First narration', estimatedDuration: 10 }, { text: 'Second narration', estimatedDuration: 10 }];
      const next = [{ text: 'Opening part.', estimatedDuration: 5 }, { text: 'Closing part.', estimatedDuration: 5 }, ...chapters.slice(1)];
      const transition = buildChapterTransition(chapters, next);
      // Splitting an earlier chapter moves two unchanged audio artifacts onto
      // overlapping source/destination chapter indices.
      assert.equal(transition.safe, true);
      assert.deepEqual(transition.reusableAudio, { 1: 2, 2: 3 });
      const fingerprints = ['a'.repeat(64), 'b'.repeat(64)];
      const originals = [wav(2), wav(3)];
      for (let index = 0; index < 2; index++) {
        const file = path.join(dir, `book_ch${index + 1}_chunk0.wav`);
        await fs.writeFile(file, originals[index]);
        await fs.writeFile(`${file}.narration-artifact.json`, JSON.stringify({ version: 1, fingerprint: fingerprints[index] }));
      }
      const worker = {
        chapterArtifactReusePlan: async (_book, chapterIndex) => ({ artifacts: [{ outputPath: path.join(dir, `book_ch${chapterIndex}_chunk0.wav`), fingerprint: fingerprints[chapterIndex - 2] }], hashPath: path.join(dir, `book_ch${chapterIndex}.texthash`), textHash: `hash-${chapterIndex}` })
      };
      const crashFs = Object.create(fs); let crashed = false;
      crashFs.rename = async (source, target) => {
        await fs.rename(source, target);
        if (!crashed && target.endsWith('book_ch3_chunk0.wav.narration-artifact.json')) {
          crashed = true;
          throw Object.assign(new Error('Crash after artifact promotion'), { simulateCrash: true });
        }
      };
      const args = { bookId: 'book', transition, nextChapters: next };
      await assert.rejects(createChapterAudioReconciler({ cacheDir: dir, workers: [worker], fs: crashFs }).reconcile(args), /Crash after artifact promotion/);
      assert.equal(crashed, true);
      if (variant === 'legacy') {
        const name = (await fs.readdir(dir)).find(name => /^\.rebuild-audio-.*\.json$/.test(name));
        const journalPath = path.join(dir, name);
        const journal = JSON.parse(await fs.readFile(journalPath));
        delete journal.phase; await fs.writeFile(journalPath, JSON.stringify(journal));
      }
      if (variant === 'partial-copy') {
        const interruptedFs = Object.create(fs);
        interruptedFs.copyFile = async (source, target) => {
          await fs.writeFile(target, (await fs.readFile(source)).subarray(0, 64));
          throw Object.assign(new Error('Crash during recovery copy'), { simulateCrash: true });
        };
        await assert.rejects(createChapterAudioReconciler({ cacheDir: dir, workers: [worker], fs: interruptedFs }).reconcile(args), /Crash during recovery copy/);
      }
      await createChapterAudioReconciler({ cacheDir: dir, workers: [worker] }).reconcile(args);
      for (let index = 0; index < 2; index++) {
        const file = path.join(dir, `book_ch${index + 2}_chunk0.wav`);
        assert((await fs.readFile(file)).equals(originals[index]), `recovered chapter ${index + 2} retains its own audio`);
        assert.equal(JSON.parse(await fs.readFile(`${file}.narration-artifact.json`)).fingerprint, fingerprints[index]);
      }
      assert(!(await fs.readdir(dir)).some(name => name.startsWith('.rebuild-audio-')));
      return { recoveredChapters: [2, 3], exactAudioBytesRetained: true };
    });

    const app = express();
    const audio = [10, 20, 30, 15].map(wav);
    const audioPaths = await Promise.all(audio.map(async (bytes, index) => {
      const file = path.join(temp, `${index}.wav`); await fs.writeFile(file, bytes); return file;
    }));
    app.get('/audit', (_req, res) => res.type('html').send('<!doctype html><title>Playback regression audit</title><h1>Playback regression audit</h1><p>Native audio with controlled HTTP delays.</p><div id="players"></div><script src="/js/lifecycle.js"></script><script src="/js/chunk-player.js"></script><script type="module">import {createPlaybackSession} from "/js/playback-session.js"; import {SingleFileChapterPlayer} from "/js/single-file-chapter-player.js"; window.createPlaybackSession=createPlaybackSession; window.SingleFileChapterPlayer=SingleFileChapterPlayer;</script>'));
    app.get('/api/chunks/:book/:chapter/manifest', async (req, res) => {
      const key = `${req.params.book}:${req.query.targetChunk || 0}`;
      const gate = gates.get(key);
      if (gate) { gates.delete(key); gate.hit.resolve(); await gate.release.promise; }
      res.json({ totalChunks: 4, servedTier: 'instant', chunks: audio.map((_, index) => ({ status: 'ready', url: `/media/${index}.wav` })) });
    });
    app.post('/api/chunks/:book/:chapter/:chunk/prioritize', (_req, res) => res.json({ success: true }));
    app.get('/api/audio-timeline/:session', (req, res) => {
      const timeline = timelines.get(req.params.session);
      if (timeline) res.json(timeline); else res.sendStatus(404);
    });
    app.get('/media/:index.wav', (req, res) => res.sendFile(audioPaths[Number(req.params.index)]));
    app.get(['/api/audio/:book/:chapter', '/api/audio-continuous/:book/:chapter'], async (req, res) => {
      const key = `${req.params.book}:audio:${req.query.offsetSeconds || 0}`;
      const gate = gates.get(key);
      if (gate) { gates.delete(key); gate.hit.resolve(); await gate.release.promise; }
      if (gate?.status) return res.sendStatus(gate.status);
      res.sendFile(audioPaths[2]);
    });
    app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = browserName === 'webkit'
      ? await webkit.launch()
      : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await page.goto(`${origin}/audit`);
    await page.waitForFunction(() => typeof window.createPlaybackSession === 'function');
    await page.evaluate(() => {
      window.players = [];
      window.makePlayer = async (book = 'audit') => {
        const audio = document.createElement('audio');
        audio.controls = true;
        document.querySelector('#players').append(audio);
        const player = new ChunkPlayer({ audio, retryDelayMs: 10 });
        players.push(player);
        await player.loadChapter(book, 0);
        return player;
      };
    });
    async function fresh(book) {
      await page.evaluate(async book => {
        for (const player of players) (player.destroy || player.dispose).call(player);
        players.length = 0;
        window.p = await makePlayer(book);
        window.seekResults = [];
      }, book);
      await page.waitForFunction(() => p._preloadReady);
    }
    function gate(book, target) {
      const item = { hit: deferred(), release: deferred() };
      allGates.add(item);
      gates.set(`${book}:${target}`, item);
      return item;
    }
    async function waitHit(item) {
      let timer;
      try { await Promise.race([item.hit.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('manifest gate not reached')), 3000); })]); }
      finally { clearTimeout(timer); }
    }
    async function nativePlayer(book, options = {}) {
      await page.evaluate(async ({ book, options }) => {
        for (const player of players) (player.destroy || player.dispose).call(player);
        players.length = 0;
        const audio = document.createElement('audio'); audio.controls = true;
        document.querySelector('#players').append(audio);
        window.p = new SingleFileChapterPlayer(audio, {
          preferStandardAudio: true, preparePlaybackRunway: false,
          getChapterCount: () => 1, getEstimatedDuration: () => 5,
          playProgressTimeoutMs: 300, ...options
        });
        players.push(p); await p.loadChapter(book, 0);
      }, { book, options });
      await page.waitForFunction(() => p.audio.readyState >= 3 && p.audio.buffered.length > 0);
    }
    await check('live playback: stale native play event cannot undo Pause state', async () => {
      await nativePlayer('stale-play-event');
      const state = await page.evaluate(async () => {
        const changes = []; p.onPlaybackChange = playing => changes.push({ playing, paused: p.audio.paused });
        const start = p.play().catch(error => ({ cancelled: Boolean(error.cancelled) }));
        p.pause(); await start;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { changes, paused: p.audio.paused, playing: p._isPlaying };
      });
      assert(!state.changes.some(change => change.playing && change.paused), JSON.stringify(state));
      assert.equal(state.playing, false); return state;
    });
    await check('live playback: early EOF before chapter limit is recoverable', async () => {
      await nativePlayer('early-limit', { preferStandardAudio: false });
      const sessionId = await page.evaluate(async () => {
        p.getChapterCount = () => 2;
        await p.loadChapter('early-limit', 0, { endChapterIndex: 1 });
        window.ends = []; window.errors = [];
        p.onChapterEnd = detail => ends.push(detail || {});
        p.onError = error => errors.push({ code: error.code, recoverable: error.recoverable, chapterIndex: error.chapterIndex });
        p.playProgressTimeoutMs = 3000;
        return p.playbackSessionId;
      });
      timelines.set(sessionId, { startChapterIndex: 0, startOffsetSeconds: 0, durations: [60, 10] });
      await page.waitForFunction(() => p._timelineDurations.get(0) === 60);
      await page.evaluate(async () => { await p.seek(29.8); await p.play(); });
      await page.waitForFunction(() => ends.length || errors.length);
      const state = await page.evaluate(() => ({ ends, errors, chapter: p.chapterIndex }));
      assert.deepEqual(state.ends, [], JSON.stringify(state));
      assert.equal(state.errors[0]?.code, 'CONTINUOUS_STREAM_EOF', JSON.stringify(state));
      assert.equal(state.errors[0]?.recoverable, true); return state;
    });
    for (const testCase of [
      { name: 'live playback: early EOF inside final chapter is recoverable', book: 'early-final', duration: 60, endChapterIndex: null, early: true },
      { name: 'live playback: completed chapter limit ends intentionally', book: 'complete-limit', duration: 30, endChapterIndex: 0, early: false }
    ]) {
      await check(testCase.name, async () => {
        await nativePlayer(testCase.book, { preferStandardAudio: false });
        const sessionId = await page.evaluate(async ({ book, endChapterIndex }) => {
          await p.loadChapter(book, 0, { endChapterIndex });
          window.ends = []; window.errors = [];
          p.onChapterEnd = detail => ends.push(detail || {});
          p.onError = error => errors.push({ code: error.code, recoverable: error.recoverable });
          p.playProgressTimeoutMs = 3000; return p.playbackSessionId;
        }, testCase);
        timelines.set(sessionId, { startChapterIndex: 0, startOffsetSeconds: 0, durations: [testCase.duration] });
        await page.waitForFunction(duration => p._timelineDurations.get(0) === duration, testCase.duration);
        await page.evaluate(async () => { await p.seek(29.8); await p.play(); });
        await page.waitForFunction(() => ends.length || errors.length);
        const state = await page.evaluate(() => ({ ends, errors }));
        if (testCase.early) {
          assert.deepEqual(state.ends, [], JSON.stringify(state));
          assert.equal(state.errors[0]?.code, 'CONTINUOUS_STREAM_EOF', JSON.stringify(state));
        } else {
          assert.deepEqual(state.errors, [], JSON.stringify(state));
          assert.equal(state.ends[0]?.reason, 'continuous-limit', JSON.stringify(state));
        }
        return state;
      });
    }
    await check('live playback: resume beyond estimate stays in requested chapter', async () => {
      await nativePlayer('resume-estimate', { preferStandardAudio: false });
      const position = await page.evaluate(async () => {
        p.getChapterCount = () => 2;
        await p.loadChapter('resume-estimate', 0, { startOffsetSeconds: 20 });
        return p.getPosition();
      });
      assert.equal(position.chapterIndex, 0, JSON.stringify(position));
      assert(Math.abs(position.currentTime - 20) < 0.1, JSON.stringify(position));
      return position;
    });
    await check('live playback: chapter mapping waits for measured boundary', async () => {
      await nativePlayer('mapping-estimate', { preferStandardAudio: false });
      const position = await page.evaluate(async () => {
        p.getChapterCount = () => 2;
        await p.seek(8);
        return p.getPosition();
      });
      assert.equal(position.chapterIndex, 0, JSON.stringify(position));
      assert(Math.abs(position.currentTime - 8) < 0.1, JSON.stringify(position));
      const sessionId = await page.evaluate(() => p.playbackSessionId);
      timelines.set(sessionId, { startChapterIndex: 0, startOffsetSeconds: 0, durations: [6, null] });
      await page.waitForFunction(() => p.chapterIndex === 1);
      const measured = await page.evaluate(() => p.getPosition());
      assert.equal(measured.chapterIndex, 1); assert(Math.abs(measured.currentTime - 2) < 0.1);
      return { pending: position, measured };
    });
    await check('live playback: measured empty chapters do not trap mapping', async () => {
      await nativePlayer('mapping-empty', { preferStandardAudio: false });
      const sessionId = await page.evaluate(async () => {
        p.getChapterCount = () => 3; await p.seek(8); return p.playbackSessionId;
      });
      timelines.set(sessionId, { startChapterIndex: 0, startOffsetSeconds: 0, durations: [6, 0, null] });
      await page.waitForFunction(() => p._timelineDurations.get(0) === 6);
      const position = await page.evaluate(() => p.getPosition());
      assert.equal(position.chapterIndex, 2, JSON.stringify(position));
      assert(Math.abs(position.currentTime - 2) < 0.1);
      const sought = await page.evaluate(async () => { await p.seek(3); return p.getPosition(); });
      assert.equal(sought.chapterIndex, 2, JSON.stringify(sought));
      assert(Math.abs(sought.currentTime - 3) < 0.1, JSON.stringify(sought));
      return { position, sought };
    });
    await check('live playback: pause at pending chapter boundary stays paused and resumes', async () => {
      await nativePlayer('boundary-pause');
      const delayed = gate('prewarm-next', 'audio:0');
      await page.evaluate(() => {
        p.getChapterCount = () => 2;
        p.resolveNextChapterUrl = () => '/api/audio/prewarm-next/1';
        window.chapterEnds = 0; p.onChapterEnd = () => { chapterEnds++; };
        p.playProgressTimeoutMs = 3000;
      });
      await page.evaluate(() => p.play());
      await waitHit(delayed);
      await page.evaluate(() => { p.audio.currentTime = 29.9; });
      await page.waitForFunction(() => p._awaitingBoundaryPrewarm);
      await page.evaluate(() => p.pause());
      delayed.release.resolve();
      await page.waitForFunction(() => p._prewarmInFlight === null);
      const paused = await page.evaluate(() => ({ ends: chapterEnds, chapter: p.chapterIndex, paused: p.audio.paused }));
      assert.equal(paused.ends, 0, JSON.stringify(paused));
      assert.equal(paused.chapter, 0); assert.equal(paused.paused, true);
      await page.evaluate(() => p.play());
      await page.waitForFunction(() => p.chapterIndex === 1 && p.isPlaying);
      return { paused, resumed: await page.evaluate(() => p.getPosition()) };
    });
    await check('live playback: pause during relocation is not a transport error', async () => {
      await nativePlayer('pause-relocate', { preferStandardAudio: false });
      await page.evaluate(() => { p.playProgressTimeoutMs = 3000; });
      await page.evaluate(() => p.play());
      const delayed = gate('pause-relocate', 'audio:40');
      await page.evaluate(() => {
        window.errors = []; p.onError = error => errors.push(error.code || error.name);
        window.relocation = p.seek(40).then(() => ({ applied: true }), error => ({ cancelled: Boolean(error.cancelled), error: error.code || error.name }));
      });
      await waitHit(delayed);
      await page.evaluate(() => p.pause());
      delayed.release.resolve();
      const state = await page.evaluate(async () => ({ result: await relocation, errors, paused: p.audio.paused, playing: p.isPlaying }));
      assert.deepEqual(state.errors, [], JSON.stringify(state));
      assert.equal(state.paused, true); assert.equal(state.playing, false);
      return state;
    });
    await check('live playback: resume falls back when pending next chapter failed', async () => {
      await nativePlayer('boundary-failed');
      const delayed = gate('prewarm-failed', 'audio:0'); delayed.status = 404;
      await page.evaluate(() => {
        p.getChapterCount = () => 2;
        p.resolveNextChapterUrl = () => '/api/audio/prewarm-failed/1';
        window.chapterEnds = 0; p.onChapterEnd = () => { chapterEnds++; };
        p.playProgressTimeoutMs = 3000;
      });
      await page.evaluate(() => p.play());
      await waitHit(delayed);
      await page.evaluate(() => { p.audio.currentTime = 29.9; });
      await page.waitForFunction(() => p._awaitingBoundaryPrewarm);
      await page.evaluate(() => p.pause()); delayed.release.resolve();
      await page.waitForFunction(() => p._prewarmInFlight === null);
      assert.equal(await page.evaluate(() => chapterEnds), 0);
      await page.evaluate(() => p.play());
      await page.waitForFunction(() => chapterEnds === 1, null, { timeout: 1000 });
      return { fallbackRequested: true };
    });
    await check('live playback: same-engine handoff preserves finite position', async () => {
      await nativePlayer('finite-handoff');
      const position = await page.evaluate(async () => {
        await p.seek(6);
        const session = createPlaybackSession(); session.setBook({ id: 'finite-handoff' }); session.adoptEngine(p);
        await session.handoffTo({ engine: p, play: false }); return p.getPosition();
      });
      assert(Math.abs(position.currentTime - 6) < 0.1, JSON.stringify(position)); return position;
    });
    await check('live playback: buffered seek exceeds estimated duration', async () => {
      await nativePlayer('estimate', { preferStandardAudio: false });
      await page.waitForFunction(() => p.audio.buffered.length && p.audio.buffered.end(0) > 20);
      const position = await page.evaluate(async () => { await p.seek(20); return p.getPosition(); });
      assert(Math.abs(position.currentTime - 20) < 0.1, JSON.stringify(position)); return position;
    });
    await check('live playback: pause cancels pending play without false timeout', async () => {
      await nativePlayer('pause-play');
      await page.evaluate(() => {
        window.playResult = null;
        window.pendingPlay = p.play().then(() => { playResult = { resolved: true }; }, error => { playResult = { cancelled: Boolean(error.cancelled), code: error.code }; });
      });
      await page.waitForFunction(() => p._playProgressWait !== null, null, { polling: 1 });
      const state = await page.evaluate(async () => {
        p.pause(); await pendingPlay;
        return { ...playResult, paused: p.audio.paused, playing: p.isPlaying };
      });
      assert.equal(state.cancelled, true, JSON.stringify(state));
      assert.equal(state.paused, true); assert.equal(state.playing, false); return state;
    });
    await check('live playback: replaced seek cannot clear newer loading state', async () => {
      await nativePlayer('relocation', { preferStandardAudio: false });
      // The target is buffered with native WAV. Explicitly open a new offset,
      // the production operation used for an unbuffered continuous seek.
      const older = gate('relocation', 'audio:20');
      await page.evaluate(() => { window.seekOne = p._reloadContinuousAtOffset(20).catch(error => ({ cancelled: error.cancelled })); });
      await waitHit(older);
      const newer = gate('relocation', 'audio:25');
      await page.evaluate(() => { window.seekTwo = p._reloadContinuousAtOffset(25); });
      await waitHit(newer);
      await page.evaluate(() => seekOne);
      const loading = await page.evaluate(() => p.isPreparingSource());
      older.release.resolve(); newer.release.resolve();
      await page.evaluate(() => seekTwo);
      assert.equal(loading, true); return { loadingWhileLatestSeekPending: loading };
    });
    await check('playback: latest seek wins', async () => {
      await fresh('seek-race');
      const delayed = gate('seek-race', 1);
      await page.evaluate(() => { window.firstSeek = p.seekToChunk(1, 2); });
      await waitHit(delayed);
      const latest = await page.evaluate(() => p.seekToChunk(3, 4));
      delayed.release.resolve();
      await page.evaluate(() => firstSeek);
      const position = await page.evaluate(() => p.getPosition());
      assert.equal(latest, true); assert.equal(position.chunkIndex, 3); assert(Math.abs(position.chunkTime - 4) < 0.1);
      return position;
    });
    await check('playback: pause supersedes pending seek resume', async () => {
      await fresh('pause-seek');
      await page.evaluate(() => p.play());
      const delayed = gate('pause-seek', 1);
      await page.evaluate(() => { window.pendingSeek = p.seekToChunk(1, 2); });
      await waitHit(delayed);
      await page.evaluate(() => p.pause());
      delayed.release.resolve();
      await page.evaluate(() => pendingSeek);
      const state = await page.evaluate(() => ({ paused: p.audio.paused, playing: p.isPlaying }));
      assert.equal(state.paused, true); assert.equal(state.playing, false); return state;
    });
    await check('playback: pause supersedes pending skip resume', async () => {
      await fresh('pause-skip');
      await page.evaluate(async () => { p.audio.currentTime = 9; await p.play(); });
      const delayed = gate('pause-skip', 1);
      await page.evaluate(() => { window.pendingSkip = p.skip(5); });
      await waitHit(delayed);
      await page.evaluate(() => p.pause());
      delayed.release.resolve();
      await page.evaluate(() => pendingSkip);
      const state = await page.evaluate(() => ({ paused: p.audio.paused, playing: p.isPlaying }));
      assert.equal(state.paused, true); assert.equal(state.playing, false); return state;
    });
    await check('playback: same-engine handoff preserves exact position', async () => {
      await fresh('same-engine');
      const position = await page.evaluate(async () => {
        await p.seekToChunk(2, 3);
        const session = createPlaybackSession();
        session.setBook({ id: 'same-engine' }); session.adoptEngine(p);
        await session.handoffTo({ engine: p, play: false });
        return p.getPosition();
      });
      assert.equal(position.chunkIndex, 2); assert(Math.abs(position.chunkTime - 3) < 0.1); return position;
    });
    await check('playback: replacement chunk engine restores exact chunk position', async () => {
      await fresh('replacement-engine');
      const position = await page.evaluate(async () => {
        await p.seekToChunk(2, 3);
        const session = createPlaybackSession();
        session.setBook({ id: 'replacement-engine' }); session.adoptEngine(p);
        const audio = document.createElement('audio'); audio.controls = true; document.querySelector('#players').append(audio);
        const incoming = new ChunkPlayer({ audio }); players.push(incoming);
        await session.handoffTo({ engine: incoming, play: false });
        return incoming.getPosition();
      });
      assert.equal(position.chunkIndex, 2); assert(Math.abs(position.chunkTime - 3) < 0.1); return position;
    });
    await check('playback: transition never checkpoints old audio as new book', async () => {
      await nativePlayer('outgoing');
      const delayed = gate('incoming', 'audio:0');
      await page.evaluate(async () => {
        p.audio.currentTime = 6;
        window.session = createPlaybackSession();
        session.setBook({ id: 'outgoing' }); session.adoptEngine(p);
        const incoming = new SingleFileChapterPlayer(document.createElement('audio'), { preferStandardAudio: true }); players.push(incoming);
        window.pendingTransition = session.transitionTo({ book: { id: 'incoming' }, chapterIndex: 1, engine: incoming, play: false });
      });
      await waitHit(delayed);
      const checkpoint = await page.evaluate(() => session.buildCheckpoint({ force: true }));
      delayed.release.resolve();
      await page.evaluate(() => pendingTransition);
      assert(!checkpoint || (checkpoint.bookId === 'outgoing' && checkpoint.chapterIndex === 0), JSON.stringify(checkpoint));
      return { checkpoint };
    });
    await page.evaluate(results => {
      for (const player of players) player.pause();
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(results, null, 2); document.body.append(pre);
    }, results);
    await page.screenshot({ path: path.join(output, `${phase}.png`), fullPage: true });
    await context.tracing.stop({ path: path.join(output, `${phase}-trace.zip`) });
  } finally {
    for (const gate of allGates) gate.release.resolve();
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({ phase, browser: browserName, results }, null, 2) + '\n');
  }
  console.log(`${results.filter(result => result.passed).length} passed, ${results.filter(result => !result.passed).length} failed`);
  process.exitCode = results.some(result => !result.passed) ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
