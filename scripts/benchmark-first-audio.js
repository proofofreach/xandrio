/**
 * Cold-start narration latency: time from a playback-runway prepare request to
 * the moment the playback gate opens, then to the first decodable input of
 * the continuous stream.
 *
 * The real ChunkedTTS, TTSQueue, ffmpeg mastering/validation passes, and
 * playback orchestrator run unchanged. Only engine synthesis is simulated,
 * because the Edge service and a Kokoro server are not reachable from every
 * machine and their timing is not reproducible: each request waits
 * `latencyMs + rtf * speechSeconds` and then yields audio of the expected
 * speech duration (Edge: MP3 from the websocket runner; Kokoro: WAV from its
 * HTTP endpoint). Each engine adapter's own chunk size, split policy,
 * concurrency, and variant key are used, so the benchmark measures whatever
 * chunking the server would use.
 *
 * Usage: node scripts/benchmark-first-audio.js [--runs N] [--json]
 *   XANDRIO_BENCH_SCENARIOS="edge:800:0.08,kokoro:300:0.14"  (name:latencyMs:rtf;
 *     names starting with "kokoro" use kokoro:am_michael, others Edge Andrew)
 *   XANDRIO_BENCH_RATE=1  listener speed reported by the runway poll
 *   XANDRIO_BENCH_CHAPTER_CHARS=8000  synthetic chapter length
 *
 * Slack is the margin by which each later chunk was ready before the playhead
 * reached it (negative = an underrun), at the listener's speed and at the
 * player's fastest speed.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ChunkedTTS = require('../lib/chunked-tts');
const TTSQueue = require('../lib/tts-queue');
const { createEngineAdapterRegistry } = require('../lib/tts-engine-adapters');
const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');

const EDGE_VOICE = 'en-US-AndrewMultilingualNeural';
const KOKORO_VOICE = 'kokoro:am_michael';
// Edge Andrew and Kokoro am_michael both narrate close to 15 characters/second.
const CHARS_PER_SECOND = 15;
const LISTENER_RATE = Number(process.env.XANDRIO_BENCH_RATE) || 1;
const CHAPTER_CHARS = Number(process.env.XANDRIO_BENCH_CHAPTER_CHARS) || 8000;
// The player's fastest selectable speed (public/js/views/playback-speed.js).
const MAX_PLAYBACK_RATE = 3;
const GATE_POLL_MS = 20;
const CLIENT_STARTUP_SECONDS = 0.5;

function parseScenarios() {
  const raw = process.env.XANDRIO_BENCH_SCENARIOS ||
    'edge:800:0.08,edge-slow:1500:0.25,kokoro:300:0.14,kokoro-slow:500:0.25';
  return raw.split(',').map(entry => {
    const [name, latencyMs, rtf] = entry.split(':');
    return { name, latencyMs: Number(latencyMs), rtf: Number(rtf) };
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = ('the river light carried old voices through narrow streets where merchants ' +
  'argued about weather and harvest while children counted boats along the quiet harbor ' +
  'remembering promises that their grandparents had made before the long winter arrived').split(' ');

function chapterText(seed, targetChars) {
  const random = seededRandom(seed);
  const paragraphs = [];
  let length = 0;
  while (length < targetChars) {
    const sentences = [];
    const count = 3 + Math.floor(random() * 6);
    for (let index = 0; index < count; index++) {
      const words = Array.from({ length: 6 + Math.floor(random() * 22) },
        () => WORDS[Math.floor(random() * WORDS.length)]);
      words[0] = words[0][0].toUpperCase() + words[0].slice(1);
      sentences.push(`${words.join(' ')}.`);
    }
    const paragraph = sentences.join(' ');
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join('\n\n');
}

function encodeSpeechLike(outputPath, seconds, format = 'mp3') {
  const codec = format === 'wav' ? ['-c:a', 'pcm_s16le', '-f', 'wav'] : ['-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3'];
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=210:sample_rate=24000:duration=${seconds.toFixed(2)}`,
      '-af', 'tremolo=f=4:d=0.7,volume=0.5',
      '-ac', '1', ...codec, outputPath
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    }, { once: true });
  });
}

// Kokoro is an HTTP engine: answer its /tts requests like the local server,
// so TTSQueue's real WAV mastering and validation path runs.
function installKokoroStub({ latencyMs, rtf }) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (!String(url).endsWith('/tts')) return originalFetch(url, options);
    const { text } = JSON.parse(options.body);
    const seconds = Math.max(1, text.length / CHARS_PER_SECOND);
    const [, wav] = await Promise.all([
      delay(latencyMs + rtf * seconds * 1000, options.signal),
      encodeSpeechLike('pipe:1', seconds, 'wav')
    ]);
    return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
  };
  return () => { global.fetch = originalFetch; };
}

function edgeStub({ latencyMs, rtf }) {
  return async (_tts, text, partPath, signal) => {
    const seconds = Math.max(1, text.length / CHARS_PER_SECOND);
    await Promise.all([delay(latencyMs + rtf * seconds * 1000, signal), encodeSpeechLike(partPath, seconds)]);
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// server.js getChapterGenerationPriority, when the policy module provides it.
let chapterGenerationPriority;
try {
  ({ playbackChunkPriority: chapterGenerationPriority } = require('../lib/playback-runway'));
} catch {}
chapterGenerationPriority ||= targetChunk => (chunkIndex, isFirstPending) => {
  if (chunkIndex === targetChunk) return 'immediate';
  if (chunkIndex === targetChunk + 1) return 'next';
  if (isFirstPending && targetChunk === 0) return 'immediate';
  return 'background';
};

async function runOnce(scenario, runIndex) {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-first-audio-'));
  const VOICE = scenario.name.startsWith('kokoro') ? KOKORO_VOICE : EDGE_VOICE;
  const adapter = createEngineAdapterRegistry({ defaultChunkSize: 4000, defaultConcurrency: 2 }).resolve(VOICE);
  const restoreFetch = VOICE === KOKORO_VOICE ? installKokoroStub(scenario) : () => {};
  const queue = new TTSQueue({
    maxConcurrent: 2,
    maxConcurrentProvider: () => adapter.concurrency(VOICE),
    cacheDir,
    defaultVoice: VOICE,
    edgeTtsRunner: edgeStub(scenario)
  });
  const tts = new ChunkedTTS(cacheDir, queue, {
    variantKeyProvider: () => adapter.variantKey(VOICE),
    voiceProvider: () => VOICE,
    outputFormatProvider: () => 'mp3',
    chunkSizeProvider: () => adapter.chunkSize(VOICE),
    splitPolicyProvider: () => adapter.splitPolicy(VOICE)
  });
  const bookId = `bench${runIndex}`;
  const chapters = [0, 1].map(index => {
    const text = chapterText(1000 + index, CHAPTER_CHARS);
    return { text, estimatedDuration: text.length / CHARS_PER_SECOND };
  });
  const readyAt = new Map();
  let t0 = 0;
  tts.on('chunk:ready', event => {
    if (event.bookId === bookId && event.chapterIndex === 0 && !readyAt.has(event.chunkIndex)) {
      readyAt.set(event.chunkIndex, performance.now() - t0);
    }
  });
  const orchestrator = createPlaybackOrchestrator({
    resolveNarrationContext: async () => ({ tier: 'active', servedTier: null, requestedTier: null, tts, voice: VOICE }),
    isPremiumVoiceActive: () => false,
    manifestNeedsResume: manifest => tts.manifestNeedsResume(manifest),
    generationPriority: chapterGenerationPriority,
    getChapterContext: async (_bookId, chapterIndex) => ({
      book: { language: 'en' }, chapter: chapters[chapterIndex], chapters
    }),
    inspectChapterAudio: async (_bookId, chapterIndex) => {
      const manifest = tts.getChapterManifest(bookId, chapterIndex);
      const readyChunks = manifest ? manifest.chunks.filter(chunk => chunk.status === 'ready').length : 0;
      return {
        ready: false,
        status: readyChunks > 0 ? 'generating' : 'pending',
        totalChunks: manifest?.totalChunks || 0,
        readyChunks,
        errorChunks: 0
      };
    },
    ensureChapterAudio: async (_bookId, chapterIndex, options) => {
      // Stand-in for ensureChapterAudioPrepared with completeChapter: claim
      // the whole chapter at one uniform priority (background for the
      // current chapter's assembly, lookahead for the next chapter). As in
      // the server, an existing playback manifest keeps its plan and only
      // gains the claim and non-demoting per-chunk priorities.
      const priority = options.priority || 'background';
      const existing = tts.getChapterManifest(bookId, chapterIndex);
      if (existing && !tts.manifestNeedsResume(existing)) {
        await tts.claimChapter(bookId, chapterIndex, {
          origin: options.origin, requestId: options.requestId || null
        }, priority, {});
        existing.chunks.forEach((chunk, index) => {
          if (chunk.status !== 'ready') tts.prioritizeChunk(bookId, chapterIndex, index, priority);
        });
        return;
      }
      await tts.generateChapter(bookId, chapterIndex, chapters[chapterIndex].text, 'en', priority, {
        voice: VOICE,
        origin: options.origin,
        requestId: options.requestId || null,
        priorityForChunk: () => priority
      });
    }
  });

  t0 = performance.now();
  // POST prepare-chapter-audio (purpose=playback-runway): current chapter
  // immediate, next chapter look-ahead.
  await orchestrator.startChapterAudio({
    bookId, chapterIndex: 0, priority: 'immediate', startOffsetSeconds: 0, completeChapter: true
  });
  orchestrator.startChapterAudio({
    bookId, chapterIndex: 1, priority: 'lookahead', completeChapter: true
  }).catch(() => {});

  let gateMs = null;
  let gateStatus = null;
  while (gateMs === null) {
    const status = await orchestrator.chapterAudioStatus({
      bookId, chapterIndex: 0, startOffsetSeconds: 0, playbackRate: LISTENER_RATE
    });
    // Same rule as aggregatePlaybackRunway in lib/routes/playback-routes.js.
    const satisfied = status.runwayEarlyStart === true ||
      (status.runwayRequiredChunks > 0 && status.runwayReadyChunks >= status.runwayRequiredChunks);
    if (satisfied) {
      gateMs = performance.now() - t0;
      gateStatus = status;
      break;
    }
    if (performance.now() - t0 > 180000) throw new Error('Playback gate did not open within 180 s');
    await sleep(GATE_POLL_MS);
  }

  const streamStart = performance.now();
  const source = await orchestrator.prepareContinuousAudioStream({ bookId, chapterIndex: 0, endChapterIndex: 0 });
  const controller = new AbortController();
  const inputs = source.iterateInputs(controller.signal);
  const first = await inputs.next();
  const streamOpenMs = performance.now() - streamStart;
  const firstInputMs = performance.now() - t0;
  if (first.done || !first.value?.path) throw new Error('Stream yielded no first input');

  // Drain the stream like the paced encoder: a 30 s burst, then 4x realtime.
  const manifest = tts.getChapterManifest(bookId, 0);
  const durations = [];
  let encodedSeconds = 0;
  const encodeStart = performance.now();
  for (let index = 0; index < manifest.totalChunks; index++) {
    if (index > 0) {
      const next = await inputs.next();
      if (next.done) break;
    }
    const duration = await tts._cachedChunkDurationSeconds(manifest.chunks[index]);
    durations.push(duration);
    encodedSeconds += duration;
    const paceUntil = Math.max(0, encodedSeconds - 30) / 4 * 1000;
    const elapsed = performance.now() - encodeStart;
    if (paceUntil > elapsed) await sleep(Math.min(paceUntil - elapsed, 5000));
  }
  controller.abort();
  await inputs.return?.();

  // Playback starts after the gate and the client's media startup. A later
  // chunk underruns when it is not ready when the playhead reaches it.
  const slackAt = rate => {
    let playhead = gateMs / 1000 + CLIENT_STARTUP_SECONDS + durations[0] / rate;
    let minimum = Infinity;
    for (let index = 1; index < durations.length; index++) {
      minimum = Math.min(minimum, playhead - readyAt.get(index) / 1000);
      playhead += durations[index] / rate;
    }
    return minimum;
  };

  tts.cancelBook?.(bookId);
  restoreFetch();
  await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  return {
    scenario: scenario.name,
    splitPolicy: adapter.splitPolicy(VOICE),
    chunkChars: manifest.chunks.slice(0, 5).map(chunk => chunk.textLength),
    totalChunks: manifest.totalChunks,
    gateMs: Math.round(gateMs),
    gateReadyChunks: gateStatus.runwayReadyChunks,
    streamOpenMs: Math.round(streamOpenMs),
    firstInputMs: Math.round(firstInputMs),
    chunk0ReadyMs: Math.round(readyAt.get(0)),
    chunk1ReadyMs: Math.round(readyAt.get(1)),
    minSlackSecondsListener: Number(slackAt(LISTENER_RATE).toFixed(1)),
    minSlackSecondsMax: Number(slackAt(MAX_PLAYBACK_RATE).toFixed(1))
  };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

(async () => {
  const runsArg = process.argv.indexOf('--runs');
  const runs = runsArg >= 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 1) : 3;
  const json = process.argv.includes('--json');
  const report = [];
  let runIndex = 0;
  for (const scenario of parseScenarios()) {
    const results = [];
    for (let run = 0; run < runs; run++) results.push(await runOnce(scenario, runIndex++));
    const summary = {
      scenario: scenario.name,
      latencyMs: scenario.latencyMs,
      rtf: scenario.rtf,
      splitPolicy: results[0].splitPolicy,
      chunkChars: results[0].chunkChars,
      totalChunks: results[0].totalChunks,
      medianGateMs: median(results.map(result => result.gateMs)),
      medianStreamOpenMs: median(results.map(result => result.streamOpenMs)),
      medianFirstInputMs: median(results.map(result => result.firstInputMs)),
      medianChunk0ReadyMs: median(results.map(result => result.chunk0ReadyMs)),
      medianChunk1ReadyMs: median(results.map(result => result.chunk1ReadyMs)),
      gateReadyChunks: results.map(result => result.gateReadyChunks),
      listenerRate: LISTENER_RATE,
      worstSlackSecondsListener: Math.min(...results.map(result => result.minSlackSecondsListener)),
      worstSlackSecondsMax: Math.min(...results.map(result => result.minSlackSecondsMax))
    };
    report.push(summary);
    if (!json) console.log(JSON.stringify(summary));
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
