'use strict';
// Failure modes recorded before implementation: an unrelated clip failure
// strands a pending clip; cancellation strands a waiter; failure handling
// prematurely rejects ready/in-flight audio; settled streams leak listeners.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const TTSQueue = require('../lib/tts-queue');
const ChunkedTTS = require('../lib/chunked-tts');
const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');
const { createChapterAudioStreamer } = require('../lib/chapter-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function tone(seconds = 0.2) {
  const rate = 24000, samples = Math.round(rate * seconds), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + 2 * i);
  return bytes;
}
(async () => {
  const output = path.resolve(__dirname, '../output/playback-reliability/server-audit');
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-audit-'));
  let failBackground;
  const backgroundGate = new Promise((_, reject) => { failBackground = () => reject(new Error('Fixture provider unavailable')); });
  backgroundGate.catch(() => {});
  let failInflightBackground, releaseInflight;
  const inflightBackground = new Promise((_, reject) => { failInflightBackground = () => reject(new Error('Fixture background failed')); });
  inflightBackground.catch(() => {});
  const inflightGate = new Promise(resolve => { releaseInflight = resolve; });
  const queue = new TTSQueue({ maxConcurrent: 1, engineAdapters: { resolve: () => ({ id: 'fixture', minimumTextLength: 20,
    generate: async ({ outputPath, signal }) => {
      if (path.basename(outputPath).startsWith('cancel')) {
        await new Promise((_, reject) => {
          const abort = () => reject(Object.assign(new Error('Fixture cancelled'), { name: 'AbortError' }));
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (path.basename(outputPath).startsWith('audit') && outputPath.includes('_chunk0.')) await backgroundGate;
      if (path.basename(outputPath).startsWith('inflight') && outputPath.includes('_chunk0.')) await inflightBackground;
      if (path.basename(outputPath).startsWith('inflight') && outputPath.includes('_chunk4.')) await inflightGate;
      await fs.writeFile(outputPath, tone());
    }
  }) } });
  const tts = new ChunkedTTS(temp, queue, { chunkSize: 100, maxMaterializedChunks: 2, reconcileIntervalMs: 0, outputFormatProvider: () => 'wav' });
  const text = 'An independent paragraph has enough spoken words to produce one clearly bounded narration clip.\n\n'.repeat(8);
  const chapter = { text, estimatedDuration: 1.6 };
  const errors = [], results = [];
  let server;
  try {
    for (const index of [2, 3]) await fs.writeFile(tts.chunkPath('audit', 0, index), tone());
    const manifest = await tts.generateChapter('audit', 0, text, 'en', 'background', { voice: 'fixture', priorityForChunk: () => 'background' });
    assert(manifest.totalChunks >= 6);
    manifest.chunks.forEach(chunk => { chunk.duration = 0.2; });
    const orchestrator = createPlaybackOrchestrator({
      resolveNarrationContext: async () => ({ tier: 'active', tts, voice: 'fixture' }),
      isPremiumVoiceActive: () => false,
      getChapterContext: async () => ({ book: { language: 'en' }, chapter, chapters: [chapter] }),
      manifestNeedsResume: current => tts.manifestNeedsResume(current),
      generationPriority: target => index => index === target ? 'immediate' : index === target + 1 ? 'next' : 'background',
      inspectStaticAudio: async () => ({ staticNoise: false }),
      inspectChapterAudio: async () => ({ ready: false }),
      ensureChapterAudio: async () => {}
    });
    const source = await orchestrator.prepareContinuousAudioStream({ bookId: 'audit', chapterIndex: 0, startOffsetSeconds: 0.4, endChapterIndex: 0 });
    const streamer = createChapterAudioStreamer({ serveAudioFile });
    const app = express();
    let normalSource, cancellationSource, inflightSource;
    app.get('/audio', async (req, res) => {
      setTimeout(failBackground, 30);
      try { await streamer.streamContinuous(req, res, source); }
      catch (error) { errors.push(error.message); if (!res.headersSent) res.status(500).end(); else res.destroy(); }
    });
    app.get('/normal', async (req, res) => {
      try { await streamer.streamContinuous(req, res, normalSource); }
      catch (error) { errors.push(error.message); res.destroy(); }
    });
    app.get('/cancel', async (req, res) => {
      setTimeout(() => tts.cancelBook('cancel'), 40);
      try { await streamer.streamContinuous(req, res, cancellationSource); }
      catch (error) { errors.push(error.message); res.destroy(); }
    });
    app.get('/inflight', async (req, res) => {
      setTimeout(failInflightBackground, 30);
      setTimeout(releaseInflight, 100);
      try { await streamer.streamContinuous(req, res, inflightSource); }
      catch (error) { errors.push(error.message); res.destroy(); }
    });
    server = await new Promise(resolve => { const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate)); });
    const began = Date.now();
    const observed = await new Promise(resolve => {
      let bytes = 0, settled = false;
      const finish = outcome => { if (settled) return; settled = true; clearTimeout(timer); resolve({ outcome, bytes, elapsedMs: Date.now() - began }); };
      const req = http.get(`http://127.0.0.1:${server.address().port}/audio`, res => {
        res.on('data', chunk => { bytes += chunk.length; });
        res.on('end', () => finish('end')); res.on('error', () => finish('transport-error'));
      });
      req.on('error', () => finish('transport-error'));
      const timer = setTimeout(() => { finish('hung'); req.destroy(); }, 1800);
    });
    await sleep(50);
    const evidence = { ...observed, errors: [...errors], halted: manifest._generation.halted,
      chunks: manifest.chunks.map(chunk => ({ index: chunk.index, status: chunk.status })), queue: queue.getQueueStatus(),
      listeners: { ready: tts.listenerCount('chunk:ready'), error: tts.listenerCount('chunk:error') } };
    const passed = observed.outcome !== 'hung' && errors.some(message => /failed|unavailable|halted/.test(message));
    results.push({ name: 'Unrelated background failure cannot strand HTTP audio on an unscheduled later clip', passed, evidence });
    const normalCount = tts.splitIntoChunks(text).length;
    for (let index = 0; index < normalCount; index++) await fs.writeFile(tts.chunkPath('normal', 0, index), tone());
    await tts.generateChapter('normal', 0, text, 'en', 'background', { voice: 'fixture' });
    normalSource = await orchestrator.prepareContinuousAudioStream({ bookId: 'normal', chapterIndex: 0, endChapterIndex: 0 });
    const normalResponse = await fetch(`http://127.0.0.1:${server.address().port}/normal`, { signal: AbortSignal.timeout(1800) });
    const normalBytes = (await normalResponse.arrayBuffer()).byteLength;
    results.push({ name: 'All ready clips still stream to normal HTTP completion', passed: normalResponse.status === 200 && normalBytes > 1000,
      evidence: { status: normalResponse.status, bytes: normalBytes } });
    const inflightManifest = await tts.generateChapter('inflight', 0, text, 'en', 'background', { voice: 'fixture', priorityForChunk: () => 'background' });
    inflightManifest.chunks.forEach(chunk => { chunk.duration = 0.2; });
    inflightSource = await orchestrator.prepareContinuousAudioStream({ bookId: 'inflight', chapterIndex: 0, startOffsetSeconds: 0.8, endChapterIndex: 0 });
    const decoded = [];
    inflightSource.onInputDecoded = descriptor => decoded.push(path.basename(descriptor.path));
    const inflightErrorStart = errors.length;
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/inflight`, { signal: AbortSignal.timeout(1800) });
      await response.arrayBuffer();
    } catch {}
    const inflightErrors = errors.slice(inflightErrorStart);
    results.push({ name: 'A sibling failure preserves the current in-flight clip before rejecting the next unscheduled clip',
      passed: decoded.some(file => file.includes('_chunk4.')) && inflightErrors.some(error => /chapter generation halted/.test(error)),
      evidence: { decoded, errors: inflightErrors } });
    await tts.generateChapter('cancel', 0, text, 'en', 'immediate', { voice: 'fixture' });
    cancellationSource = await orchestrator.prepareContinuousAudioStream({ bookId: 'cancel', chapterIndex: 0, endChapterIndex: 0 });
    const cancellationBegan = Date.now();
    let cancellationResult;
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/cancel`, { signal: AbortSignal.timeout(1800) });
      await response.arrayBuffer(); cancellationResult = 'unexpected-completion';
    } catch (error) { cancellationResult = error.name === 'TimeoutError' ? 'hung' : 'transport-error'; }
    await sleep(30);
    const listeners = Object.fromEntries(['chunk:ready', 'chunk:error', 'chapter:cancelled', 'book:cancelled'].map(event => [event, tts.listenerCount(event)]));
    results.push({ name: 'Book cancellation settles the HTTP stream and removes all listeners',
      passed: cancellationResult === 'transport-error' && errors.includes('Chapter generation cancelled') && Object.values(listeners).every(count => count === 0),
      evidence: { outcome: cancellationResult, elapsedMs: Date.now() - cancellationBegan, listeners, errors } });
    console.log(JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(output, `${process.env.GENERATION_AUDIT_PHASE || 'verification'}.json`), JSON.stringify(results, null, 2));
    if (results.some(result => !result.passed)) process.exitCode = 1;
  } finally {
    failBackground(); failInflightBackground(); releaseInflight();
    tts.cancelBook('audit'); tts.cancelBook('cancel'); tts.cancelBook('inflight'); tts.stopReconcileLoop();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
