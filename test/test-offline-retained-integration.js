const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createOfflineAudioPackage, sourceVariantKey: sourceKeyForPackage } = require('../lib/offline-audio-package');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-retained-integration-'));
  const data = path.join(root, 'data');
  const cache = path.join(root, 'cache');
  await fs.mkdir(data); await fs.mkdir(cache);
  process.env.DATA_DIR = data;
  process.env.CACHE_DIR = cache;
  process.env.XANDRIO_TOKEN = 'offline-recovery-test-token';
  process.env.XANDRIO_VOICE_PROVIDERS = 'edge,kokoro';
  process.env.KOKORO_AUTO_START = 'false';
  process.env.CHATTERBOX_AUTO_START = 'false';
  const book = { id: 'napoleon-fixture', title: 'Napoleon fixture', language: 'en',
    addedAt: '2026-08-01T00:00:00Z', path: path.join(cache, 'napoleon-fixture.epub') };
  const chapters = [{ text: 'First chapter', title: 'First' }, { empty: true, text: '', title: 'Part' },
    { text: 'Last chapter', title: 'Last' }];
  await fs.writeFile(book.path, 'source identity fixture');
  await fs.utimes(book.path, new Date(0), new Date(0));
  await fs.writeFile(book.path.replace('.epub', '.chapters.json'), JSON.stringify({ _cacheVersion: 29, chapters }));
  await fs.writeFile(path.join(data, 'books.json'), JSON.stringify({ [book.id]: book }));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ voice: 'kokoro:am_onyx' }));
  const sourceVariantKey = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep8:audio6:br160k:pause350';
  const packages = createOfflineAudioPackage({ cacheDir: cache });
  const legacy = packages.chapterPath({ bookId: book.id, chapterIndex: 0, sourceVariantKey });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=0.2', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k', legacy]);
  await fs.copyFile(legacy, packages.chapterPath({ bookId: book.id, chapterIndex: 2, sourceVariantKey }));
  const originalBytes = await fs.readFile(legacy);
  const originalHash = `sha256-${crypto.createHash('sha256').update(originalBytes).digest('hex')}`;
  const { app } = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${process.env.XANDRIO_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const currentManifest = await (await fetch(`${origin}/api/offline/preparation/${book.id}/manifest`, { headers })).json();
    const currentSource = sourceKeyForPackage(currentManifest.packageVariantKey);
    for (const chapterIndex of [0, 2]) {
      await fs.copyFile(legacy, packages.chapterPath({ bookId: book.id, chapterIndex, sourceVariantKey: currentSource }));
    }
    const preparationResponse = await fetch(`${origin}/api/offline/preparation/${book.id}`, { method: 'POST', headers });
    assert.equal(preparationResponse.status, 202, await preparationResponse.text());
    const deadline = Date.now() + 5000;
    let prepared;
    while (Date.now() < deadline) {
      prepared = await (await fetch(`${origin}/api/offline/preparation/${book.id}`, { headers })).json();
      if (prepared.state === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(prepared.state, 'ready', JSON.stringify(prepared));
    assert(!(await fs.readdir(cache)).some(name => /_tts.*\.mp3$/.test(name)));
    console.log('  ✓ ordinary preparation validates existing compact audio before requesting a missing stitched source');

    const response = await fetch(`${origin}/api/admin/offline/preparation/${book.id}/recover`, {
      method: 'POST', headers, body: JSON.stringify({ sourceVoice: 'kokoro:am_onyx', sourceVariantKey,
        acceptUnverifiedSourceAssociation: true })
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const events = body.trim().split('\n').map(JSON.parse);
    const result = events.at(-1).result;
    assert(result, body);
    assert.equal(result.preparation.state, 'ready', body);
    assert.equal(result.preparation.readyChapters, 3);
    assert.equal(result.bytes, originalBytes.length * 2);
    const catalogNames = (await fs.readdir(cache)).filter(name => name.includes('_offline-ready_'));
    const catalogs = await Promise.all(catalogNames.map(async name => JSON.parse(await fs.readFile(path.join(cache, name), 'utf8'))));
    assert(catalogs.some(catalog => catalog.identity.sourceVariantKey === sourceVariantKey && catalog.associationSource === 'operator'));
    console.log('  ✓ real legacy MP3 recovery reaches ready without stitched sources or TTS');

    const status = await (await fetch(`${origin}/api/offline/preparation/${book.id}`, { headers })).json();
    const manifest = await (await fetch(`${origin}/api/offline/preparation/${book.id}/manifest`, { headers })).json();
    assert.equal(status.state, 'ready');
    assert.equal(manifest.state, 'ready', JSON.stringify(manifest));
    assert.equal(manifest.packageVariantKey, status.packageVariantKey);
    const repeated = await Promise.all(Array.from({ length: 3 }, async () => {
      const response = await fetch(`${origin}/api/offline/preparation/${book.id}`, { method: 'POST', headers });
      assert.equal(response.status, 202);
      return response.json();
    }));
    for (const item of repeated) {
      assert.equal(item.state, 'ready');
      assert.equal(item.bytesTotal, originalBytes.length * 2);
    }
    assert.equal(manifest.chapters[0].artifactId, originalHash);
    assert.equal(manifest.chapters[0].provenance, 'legacy-unverified');
    assert.equal(manifest.chapters[1].state, 'empty');
    const again = await (await fetch(`${origin}/api/offline/preparation/${book.id}/manifest`, { headers })).json();
    assert.equal(again.sourceRevision, manifest.sourceRevision);
    console.log('  ✓ status and manifest consistently select the original complete package');

    const audio = await fetch(new URL(manifest.chapters[0].url, origin), { headers: { ...headers, Range: 'bytes=0-1' } });
    assert.equal(audio.status, 206);
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), originalBytes.subarray(0, 2));
    assert.equal(audio.headers.get('etag'), `"${originalHash}"`);
    assert.deepEqual(await fs.readFile(legacy), originalBytes);
    assert(!(await fs.readdir(cache)).some(name => /_tts.*\.mp3$/.test(name)));
    console.log('  ✓ ranged delivery preserves the exact legacy bytes and artifact identity');
    console.log('\n4 passed, 0 failed');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
