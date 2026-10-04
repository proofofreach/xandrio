// Failure modes recorded before implementation: each playlist refresh scans all
// retained files; removing those scans disables the storage cap; a refresh
// creates another encoder or changes the playlist/segment URLs.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');

const output = path.resolve(__dirname, '../output/playback-reliability');
const phase = process.env.HLS_MAINTENANCE_PHASE || 'verification';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tone() {
  const rate = 24000, samples = rate * 5;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 0.1)), 44 + i * 2);
  return bytes;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-hls-maintenance-'));
  const audio = path.join(temp, 'tone.wav');
  await fs.writeFile(audio, tone());
  const results = [];
  let scans = 0;
  const originalReaddir = fs.readdir;
  fs.readdir = async function(directory, ...args) {
    if (String(directory).startsWith(temp + path.sep)) scans++;
    return originalReaddir.call(this, directory, ...args);
  };
  async function check(name, fn) {
    try {
      const evidence = await fn();
      results.push({ name, passed: true, evidence });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  async function fixture(name, maintenanceIntervalMs, work) {
    const hls = createHlsAudioStreamer({
      serveAudioFile, rootDir: path.join(temp, name),
      maxStorageBytes: 1024 * 1024, maintenanceIntervalMs
    });
    let sourceCount = 0;
    const app = express();
    app.get('/playlist', async (req, res, next) => {
      try {
        await hls.servePlaylist(req, res, {
          key: 'same-playback', ownerKey: 'fixture',
          createSource: async () => {
            sourceCount++;
            return { chapterIndex: 0, async *iterateInputs() { yield audio; } };
          }
        });
      } catch (error) { next(error); }
    });
    app.get('/api/audio-hls-segment/:id/:file', (req, res, next) => {
      hls.serveSegment(req, res, req.params.id, req.params.file).catch(next);
    });
    const server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const first = await fetch(`${origin}/playlist`);
      assert.equal(first.status, 200);
      await first.text();
      const session = [...hls.sessionsById.values()][0];
      await session.runPromise;
      await sleep(20);
      await work({ hls, session, origin, sourceCount: () => sourceCount });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await hls.dispose();
    }
  }
  try {
    await check('playlist polling reuses the stream without scanning retained files', async () => {
      let evidence;
      await fixture('polls', 0, async ({ hls, session, origin, sourceCount }) => {
        // Model a retained long session without synthesizing hours of audio.
        await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(path.join(session.directory, `retained-${i}`), 'x')));
        const before = scans;
        let playlist;
        for (let i = 0; i < 12; i++) {
          const response = await fetch(`${origin}/playlist`);
          assert.equal(response.status, 200);
          playlist = await response.text();
          await sleep(20);
        }
        await sleep(100);
        const segmentUrl = playlist.split('\n').find(line => line.startsWith('/api/'));
        const segment = await fetch(origin + segmentUrl);
        assert.equal(segment.status, 200);
        assert((await segment.arrayBuffer()).byteLength > 100);
        evidence = { polls: 12, retainedFiles: 1000, directoryScans: scans - before, sourceCount: sourceCount() };
        assert.equal(sourceCount(), 1);
        assert.equal(evidence.directoryScans, 0, JSON.stringify(evidence));
        assert(playlist.includes('#EXT-X-PLAYLIST-TYPE:EVENT'));
        assert.equal(hls.sessionsById.size, 1);
      });
      return evidence;
    });
    await check('scheduled maintenance still enforces the storage limit', async () => {
      let evidence;
      await fixture('timer', 250, async ({ hls, session }) => {
        await fs.writeFile(path.join(session.directory, 'oversized-retained-data'), Buffer.alloc(2 * 1024 * 1024));
        const started = Date.now();
        while (hls.sessionsById.size && Date.now() - started < 2000) await sleep(25);
        assert.equal(hls.sessionsById.size, 0, 'scheduled storage eviction did not run');
        evidence = { evicted: true, elapsedMs: Date.now() - started };
      });
      return evidence;
    });
    await check('explicit maintenance still enforces the storage limit', async () => {
      await fixture('manual', 0, async ({ hls, session }) => {
        await fs.writeFile(path.join(session.directory, 'oversized-retained-data'), Buffer.alloc(2 * 1024 * 1024));
        await hls.maintain();
        assert.equal(hls.sessionsById.size, 0);
      });
      return { evicted: true };
    });
  } finally {
    fs.readdir = originalReaddir;
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `hls-maintenance-${phase}.json`), JSON.stringify({ results }, null, 2));
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
