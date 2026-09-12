const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  OFFLINE_AUDIO_BITRATE_KBPS,
  OFFLINE_AUDIO_BLOCK_SIZE,
  computeIntegrity,
  createOfflineAudioPackage,
  packageTimeoutMs
} = require('../lib/offline-audio-package');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.error('  ✗ ' + name);
    console.error('    ' + (error.stack || error.message));
  }
}

function probeResult(size, duration = 60) {
  return {
    stdout: JSON.stringify({
      streams: [{
        codec_type: 'audio',
        codec_name: 'mp3',
        sample_rate: '24000',
        channels: 1,
        duration: String(duration)
      }],
      format: { duration: String(duration), size: String(size) }
    }),
    stderr: ''
  };
}

function fakeCommandRunner({ output = Buffer.from('compact audio'), onCall = () => {} } = {}) {
  return async (command, args, { signal } = {}) => {
    if (signal?.aborted) {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    }
    onCall(command, args);
    if (command === 'ffprobe') {
      const stat = await fs.stat(args.at(-1));
      return probeResult(stat.size);
    }
    const formatIndex = args.lastIndexOf('-f');
    if (command === 'ffmpeg' && formatIndex >= 0 && args[formatIndex + 1] === 'mp3') {
      await fs.writeFile(args.at(-1), output);
    }
    return { stdout: '', stderr: '' };
  };
}

function silenceWav(sampleRate = 24000, durationSeconds = 0.25) {
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function withCache(prefix, callback) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(cacheDir);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

(async () => {
  await test('creates and commits a verified immutable package descriptor', async () => {
    await withCache('offline-audio-package-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'playback master');
      const calls = [];
      const sourceFingerprint = 'a'.repeat(64);
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner({
          onCall: (command, args) => calls.push({ command, args })
        })
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a:br160k',
        sourceFingerprint,
        provenance: 'verified'
      };

      const result = await audioPackage.ensureChapter(request);

      assert.strictEqual(OFFLINE_AUDIO_BITRATE_KBPS, 48);
      assert.strictEqual(result.ready, true);
      assert.strictEqual(result.bitrateKbps, 48);
      assert.strictEqual(result.sampleRate, 24000);
      assert.strictEqual(result.channels, 1);
      assert.strictEqual(result.provenance, 'verified');
      assert.strictEqual(result.sourceFingerprint, 'sha256-' + sourceFingerprint);
      assert.match(result.variantKey, /offline-mp3-v1:br48k$/);
      assert.match(
        path.basename(result.path),
        /^book-1_offline_[a-f0-9]{16}_ch0_sha256-[a-f0-9]{64}\.mp3$/
      );
      assert.strictEqual(result.artifactId, result.contentHash);
      assert.strictEqual(result.etag, '"' + result.artifactId + '"');
      assert.strictEqual(result.blockSize, OFFLINE_AUDIO_BLOCK_SIZE);
      assert.strictEqual(result.blockHashes.length, 1);
      assert.strictEqual(await fs.readFile(result.path, 'utf8'), 'compact audio');
      assert.strictEqual(
        JSON.parse(await fs.readFile(audioPackage.integrityPath(request), 'utf8')).artifactId,
        result.artifactId
      );

      const encode = calls.find(call =>
        call.command === 'ffmpeg' &&
        call.args[call.args.lastIndexOf('-f') + 1] === 'mp3'
      );
      assert(encode, 'ffmpeg encode must run');
      assert(encode.args.includes('-xerror'));
      assert.deepStrictEqual(
        encode.args.slice(encode.args.indexOf('-ac'), encode.args.indexOf('-ac') + 4),
        ['-ac', '1', '-ar', '24000']
      );
      assert(encode.args.includes('48k'));
      assert.deepStrictEqual(
        encode.args.slice(encode.args.indexOf('-threads'), encode.args.indexOf('-threads') + 2),
        ['-threads', '1']
      );
      assert.match(path.basename(encode.args.at(-1)), /\.mp3\.\d+\.[a-f0-9]+\.part\.mp3$/);
      assert(calls.some(call => call.command === 'ffmpeg' && call.args.at(-1) === '-'));
      assert.strictEqual((await audioPackage.inspectChapter(request)).ready, true);
    });
  });

  await test('reuses a committed descriptor without another probe or transcode', async () => {
    await withCache('offline-audio-reuse-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'playback master');
      let calls = 0;
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner({ onCall: () => { calls += 1; } })
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a:br160k'
      };

      const first = await audioPackage.ensureChapter(request);
      const afterFirst = calls;
      const second = await audioPackage.ensureChapter(request);

      assert.strictEqual(first.artifactId, second.artifactId);
      assert.strictEqual(calls, afterFirst);
    });
  });

  await test('backfills a valid legacy package without retranscoding or deleting it', async () => {
    await withCache('offline-audio-legacy-', async cacheDir => {
      let encodeCalls = 0;
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner({
          onCall: (command, args) => {
            const format = args[args.lastIndexOf('-f') + 1];
            if (command === 'ffmpeg' && format === 'mp3') encodeCalls += 1;
          }
        })
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourceVariantKey: 'voice-a:br160k',
        sourceFingerprint: 'b'.repeat(64),
        provenance: 'verified'
      };
      const legacyPath = audioPackage.chapterPath(request);
      await fs.writeFile(legacyPath, 'legacy compact audio');

      const before = await audioPackage.inspectChapter(request);
      assert.strictEqual(before.ready, false);
      assert.strictEqual(before.legacySize, Buffer.byteLength('legacy compact audio'));

      const result = await audioPackage.ensureChapter(request);
      assert.strictEqual(result.ready, true);
      assert.strictEqual(result.provenance, 'legacy-unverified');
      assert.strictEqual(result.sourceFingerprint, result.artifactId);
      assert.strictEqual(result.associatedRecipeFingerprint, 'sha256-' + 'b'.repeat(64));
      assert.strictEqual(encodeCalls, 0);
      assert.strictEqual(await fs.readFile(legacyPath, 'utf8'), 'legacy compact audio');
      assert.strictEqual((await audioPackage.inspectChapter({
        ...request,
        sourceFingerprint: 'c'.repeat(64)
      })).ready, false);
    });
  });

  await test('hashes whole content and fixed one MiB blocks', async () => {
    await withCache('offline-audio-blocks-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      const output = Buffer.alloc(OFFLINE_AUDIO_BLOCK_SIZE + 17, 23);
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner({ output })
      });
      const result = await audioPackage.ensureChapter({
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a'
      });
      assert.strictEqual(result.size, output.length);
      assert.strictEqual(result.blockHashes.length, 2);
      assert.notStrictEqual(result.blockHashes[0], result.blockHashes[1]);
    });
  });

  await test('does not publish a descriptor when the request epoch guard fails', async () => {
    await withCache('offline-audio-guard-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner()
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a',
        beforePublish: async current => {
          assert.strictEqual(current.bookId, 'book-1');
          throw new Error('stale request epoch');
        }
      };

      await assert.rejects(audioPackage.ensureChapter(request), /stale request epoch/);
      assert.strictEqual((await audioPackage.inspectChapter(request)).ready, false);
      await assert.rejects(fs.stat(audioPackage.integrityPath(request)), error => error.code === 'ENOENT');
      const names = await fs.readdir(cacheDir);
      assert.strictEqual(names.some(name => name.endsWith('.part.mp3')), false);
    });
  });

  await test('cancelBook aborts active work and waitForIdle observes quiescence', async () => {
    await withCache('offline-audio-cancel-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      let encodeStarted;
      const started = new Promise(resolve => { encodeStarted = resolve; });
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: async (command, args, { signal } = {}) => {
          if (command === 'ffprobe') {
            const stat = await fs.stat(args.at(-1));
            return probeResult(stat.size);
          }
          const format = args[args.lastIndexOf('-f') + 1];
          if (format !== 'mp3') return { stdout: '', stderr: '' };
          encodeStarted();
          return new Promise((resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            signal.addEventListener('abort', abort, { once: true });
          });
        }
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a'
      };
      const ensuring = audioPackage.ensureChapter(request);
      await started;
      assert.strictEqual(await audioPackage.cancelBook('book-1'), 1);
      await assert.rejects(ensuring, error => error.name === 'AbortError');
      await audioPackage.waitForIdle('book-1');
      assert.strictEqual((await audioPackage.inspectChapter(request)).ready, false);
    });
  });

  await test('keeps shared packaging alive while one deduplicated consumer remains', async () => {
    await withCache('offline-audio-consumers-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      let startEncode;
      const encoding = new Promise(resolve => { startEncode = resolve; });
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: async (command, args) => {
          if (command === 'ffprobe') {
            const stat = await fs.stat(args.at(-1));
            return probeResult(stat.size);
          }
          const format = args[args.lastIndexOf('-f') + 1];
          if (format === 'mp3') {
            startEncode();
            await new Promise(resolve => setTimeout(resolve, 20));
            await fs.writeFile(args.at(-1), 'shared compact audio');
          }
          return { stdout: '', stderr: '' };
        }
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a'
      };
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = audioPackage.ensureChapter({ ...request, signal: firstController.signal });
      const second = audioPackage.ensureChapter({ ...request, signal: secondController.signal });
      await encoding;
      firstController.abort();

      await assert.rejects(first, error => error.name === 'AbortError');
      assert.strictEqual((await second).ready, true);
    });
  });

  await test('cancelBook fences an ensure invocation still awaiting its first inspection', async () => {
    await withCache('offline-audio-pending-inspect-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      let inspectionStarted;
      let releaseInspection;
      const started = new Promise(resolve => { inspectionStarted = resolve; });
      const release = new Promise(resolve => { releaseInspection = resolve; });
      const packageFs = Object.create(fs);
      packageFs.readFile = async (target, ...args) => {
        if (String(target).endsWith('.offline-integrity.json')) {
          inspectionStarted();
          await release;
        }
        return fs.readFile(target, ...args);
      };
      let commands = 0;
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        fs: packageFs,
        runCommand: fakeCommandRunner({ onCall: () => { commands += 1; } })
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a'
      };
      const ensuring = audioPackage.ensureChapter(request);
      await started;
      const rejected = assert.rejects(ensuring, error => error.name === 'AbortError');
      const cancelling = audioPackage.cancelBook('book-1');
      releaseInspection();
      await rejected;
      assert.strictEqual(await cancelling, 1);
      assert.strictEqual(commands, 0);
      assert.strictEqual((await audioPackage.inspectChapter(request)).ready, false);
    });
  });

  await test('rolls back a sidecar publication cancelled after atomic rename', async () => {
    await withCache('offline-audio-publish-race-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      let sidecarRenamed;
      let releaseRename;
      const renamed = new Promise(resolve => { sidecarRenamed = resolve; });
      const release = new Promise(resolve => { releaseRename = resolve; });
      let intercepted = false;
      const packageFs = Object.create(fs);
      packageFs.rename = async (source, destination) => {
        await fs.rename(source, destination);
        if (!intercepted && String(destination).endsWith('.offline-integrity.json')) {
          intercepted = true;
          sidecarRenamed();
          await release;
        }
      };
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        fs: packageFs,
        runCommand: fakeCommandRunner()
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a'
      };
      const ensuring = audioPackage.ensureChapter(request);
      await renamed;
      const rejected = assert.rejects(ensuring, error => error.name === 'AbortError');
      const cancelling = audioPackage.cancelBook('book-1');
      releaseRename();
      await rejected;
      await cancelling;
      await assert.rejects(
        fs.stat(audioPackage.integrityPath(request)),
        error => error.code === 'ENOENT'
      );
    });
  });

  await test('an aborted publication guard cannot authorize another consumer', async () => {
    await withCache('offline-audio-guard-consumer-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'source');
      let firstGuardStarted;
      let releaseFirstGuard;
      const guardStarted = new Promise(resolve => { firstGuardStarted = resolve; });
      const releaseGuard = new Promise(resolve => { releaseFirstGuard = resolve; });
      const guardCalls = [0, 0];
      const controllers = [new AbortController(), new AbortController()];
      let firstGuardIndex = null;
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner()
      });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a'
      };
      const ensuring = controllers.map((controller, index) => audioPackage.ensureChapter({
        ...request,
        signal: controller.signal,
        beforePublish: async () => {
          guardCalls[index] += 1;
          // Filesystem inspection can finish in either order. Abort the
          // consumer whose guard actually starts first, not the first caller.
          if (firstGuardIndex === null) {
            firstGuardIndex = index;
            firstGuardStarted(index);
            await releaseGuard;
          }
        }
      }));
      const abortedIndex = await guardStarted;
      const remainingIndex = 1 - abortedIndex;
      const firstRejected = assert.rejects(ensuring[abortedIndex], error => error.name === 'AbortError');
      controllers[abortedIndex].abort();
      releaseFirstGuard();
      await firstRejected;
      assert.strictEqual((await ensuring[remainingIndex]).ready, true);
      assert.deepStrictEqual(guardCalls, [1, 1]);
    });
  });

  await test('never exceeds two process-wide package slots during handoff', async () => {
    await withCache('offline-audio-semaphore-', async cacheDir => {
      let active = 0;
      let peak = 0;
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: async (command, args) => {
          if (command === 'ffprobe') {
            const stat = await fs.stat(args.at(-1));
            return probeResult(stat.size);
          }
          const format = args[args.lastIndexOf('-f') + 1];
          if (format === 'mp3') {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            await fs.writeFile(args.at(-1), 'compact audio');
            active -= 1;
          }
          return { stdout: '', stderr: '' };
        }
      });
      const requests = [];
      for (let index = 0; index < 8; index += 1) {
        const sourcePath = path.join(cacheDir, 'source-' + index + '.mp3');
        await fs.writeFile(sourcePath, 'source');
        requests.push(audioPackage.ensureChapter({
          bookId: 'book-' + index,
          chapterIndex: 0,
          sourcePath,
          sourceVariantKey: 'voice-a'
        }));
      }
      await Promise.all(requests);
      assert(peak <= 2, 'observed ' + peak + ' concurrent package jobs');
    });
  });

  await test('startup cleanup removes the old mp3.part temporary grammar', async () => {
    await withCache('offline-audio-cleanup-', async cacheDir => {
      const audioPackage = createOfflineAudioPackage({ cacheDir });
      const request = {
        bookId: 'book-1',
        chapterIndex: 0,
        sourceVariantKey: 'voice-a'
      };
      const oldTemporary = audioPackage.chapterPath(request) + '.part';
      const recentTemporary = audioPackage.chapterPath({ ...request, chapterIndex: 1 }) + '.part';
      await Promise.all([
        fs.writeFile(oldTemporary, 'old'),
        fs.writeFile(recentTemporary, 'recent')
      ]);
      const oldTime = new Date(Date.now() - (25 * 60 * 60 * 1000));
      await fs.utimes(oldTemporary, oldTime, oldTime);
      assert.strictEqual(await audioPackage.cleanupStaleTemps(), 1);
      await assert.rejects(fs.stat(oldTemporary), error => error.code === 'ENOENT');
      assert.strictEqual((await fs.stat(recentTemporary)).isFile(), true);
    });
  });

  await test('aborts a stalled integrity stream', async () => {
    const { Readable } = require('stream');
    const controller = new AbortController();
    let read = false;
    const hashing = computeIntegrity('/unused', {
      signal: controller.signal,
      createReadStream: () => new Readable({
        read() {
          if (read) return;
          read = true;
          this.push(Buffer.alloc(1024, 1));
        }
      })
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(hashing, error => error.name === 'AbortError');
  });

  await test('uses bounded duration-derived package timeouts', async () => {
    assert.strictEqual(packageTimeoutMs(1), 120000);
    assert.strictEqual(packageTimeoutMs(100), 200000);
    assert.strictEqual(packageTimeoutMs(5000), 1800000);
    assert.strictEqual(packageTimeoutMs(Number.NaN), 1800000);
  });

  await test('uses real ffmpeg to encode and validate a small audio fixture', async () => {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 ||
        spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0) {
      console.log('    skipped: ffmpeg and ffprobe are unavailable');
      return;
    }
    await withCache('offline-audio-real-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'source.wav');
      await fs.writeFile(sourcePath, silenceWav());
      const audioPackage = createOfflineAudioPackage({ cacheDir });
      const result = await audioPackage.ensureChapter({
        bookId: 'real-book',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'fixture'
      });
      assert.strictEqual(result.ready, true);
      assert(result.size > 0);
      assert.strictEqual(result.blockHashes.length, 1);
    });
  });

  await test('does not reuse a derivative from a different narration variant', async () => {
    await withCache('offline-audio-variant-', async cacheDir => {
      const sourcePath = path.join(cacheDir, 'book_ch0.mp3');
      await fs.writeFile(sourcePath, 'playback master');
      const audioPackage = createOfflineAudioPackage({
        cacheDir,
        runCommand: fakeCommandRunner()
      });
      const first = await audioPackage.ensureChapter({
        bookId: 'book-1',
        chapterIndex: 0,
        sourcePath,
        sourceVariantKey: 'voice-a:br160k'
      });
      const second = await audioPackage.inspectChapter({
        bookId: 'book-1',
        chapterIndex: 0,
        sourceVariantKey: 'voice-b:br160k'
      });
      assert.strictEqual(second.ready, false);
      assert.notStrictEqual(first.path, second.path);
    });
  });

  await test('recovers the pinned narration identity from an offline package key', async () => {
    await withCache('offline-audio-identity-', async cacheDir => {
      const audioPackage = createOfflineAudioPackage({ cacheDir });
      const packageKey = audioPackage.packageVariantKey('voice-a:chunk4000:br160k');
      assert.strictEqual(
        audioPackage.sourceVariantKey(packageKey),
        'voice-a:chunk4000:br160k'
      );
      assert.throws(
        () => audioPackage.sourceVariantKey('voice-a:offline-mp3-v9:br32k'),
        /Invalid offline audio package identity/
      );
    });
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
