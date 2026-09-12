'use strict';

const fsp = require('fs/promises');
const { spawn } = require('child_process');
const { MASTERING_POLICY, getMasteringBitrate } = require('./audio-quality');

const AUDIO_CACHE_CONTROL = 'no-store';

function clientDisconnectError() {
  return Object.assign(new Error('Audio request closed'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  });
}

function isClientDisconnect(error) {
  return error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

async function existingNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    return (await fsp.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

function captureStderr(child) {
  let stderr = '';
  child.stderr?.on('data', chunk => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString();
  });
  return () => stderr.trim();
}

function waitForChild(child, label, stderr, signal) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    // Pipe errors can arrive after cancellation or between decoded inputs.
    // Keep this handler for the pipe lifetime, including queued errors at close.
    child.stdin?.on('error', error => {
      killChild(child);
      reject(signal?.aborted ? clientDisconnectError() : error);
    });
    child.once('close', (code, childSignal) => {
      if (code === 0) return resolve();
      if (signal?.aborted) return reject(clientDisconnectError());
      const detail = stderr();
      reject(new Error(
        `${label} exited with ${childSignal ? `signal ${childSignal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`
      ));
    });
  });
}

async function writeToStream(writable, chunk, signal) {
  if (signal?.aborted || writable.destroyed) throw clientDisconnectError();
  if (writable.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off('drain', onDrain);
      writable.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(clientDisconnectError());
    };
    const onAbort = () => {
      cleanup();
      reject(clientDisconnectError());
    };
    writable.once('drain', onDrain);
    writable.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted || writable.destroyed) onAbort();
  });
}

async function pump(readable, writable, signal, options = {}) {
  let written = 0;
  for await (const chunk of readable) {
    let output = chunk;
    if (options.skipState?.remaining > 0) {
      const skipped = Math.min(options.skipState.remaining, output.length);
      options.skipState.remaining -= skipped;
      output = output.subarray(skipped);
    }
    if (output.length === 0) continue;
    if (options.pace) await options.pace(output.length);
    await writeToStream(writable, output, signal);
    written += output.length;
  }
  return written;
}

function encodedBytesPerSecond(format) {
  if (format === 'wav') {
    return MASTERING_POLICY.sampleRate * MASTERING_POLICY.channels * 2;
  }
  const match = String(getMasteringBitrate()).match(/^(\d+)k$/);
  return (Number(match?.[1]) || 160) * 1000 / 8;
}

function pcmBytesForSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const frames = Math.round(seconds * MASTERING_POLICY.sampleRate);
  return frames * MASTERING_POLICY.channels * 2;
}

function createOutputPacer({
  format,
  burstAudioSeconds = 30,
  realtimeMultiplier = 4,
  now = () => Date.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const bytesPerSecond = encodedBytesPerSecond(format);
  const rate = bytesPerSecond * Math.max(1, Number(realtimeMultiplier) || 4);
  const burst = bytesPerSecond * Math.max(0, Number(burstAudioSeconds) || 0);
  const startedAt = now();
  let emitted = 0;

  return async byteLength => {
    emitted += Math.max(0, Number(byteLength) || 0);
    const available = burst + ((now() - startedAt) / 1000 * rate);
    if (emitted <= available) return;
    await wait((emitted - available) / rate * 1000);
  };
}

async function pumpOutput(readable, writable, signal, pacing, pacingRuntime) {
  const pace = pacing
    ? createOutputPacer({ ...pacing, ...pacingRuntime })
    : null;
  for await (const chunk of readable) {
    if (pace) await pace(chunk.length);
    await writeToStream(writable, chunk, signal);
  }
}

function encoderArgs(format) {
  const output = format === 'wav'
    ? ['-c:a', 'pcm_s16le', '-f', 'wav']
    : ['-c:a', 'libmp3lame', '-b:a', getMasteringBitrate(), '-f', 'mp3'];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 's16le',
    '-ar', String(MASTERING_POLICY.sampleRate),
    '-ac', String(MASTERING_POLICY.channels),
    '-i', 'pipe:0',
    '-map_metadata', '-1',
    '-vn',
    '-ac', String(MASTERING_POLICY.channels),
    '-ar', String(MASTERING_POLICY.sampleRate),
    ...output,
    '-flush_packets', '1',
    'pipe:1'
  ];
}

function decoderArgs(filePath) {
  return [
    '-hide_banner', '-loglevel', 'error', '-xerror', '-nostdin',
    '-i', filePath,
    '-map_metadata', '-1',
    '-vn',
    '-f', 's16le',
    '-ac', String(MASTERING_POLICY.channels),
    '-ar', String(MASTERING_POLICY.sampleRate),
    'pipe:1'
  ];
}

async function decodeInto(filePath, encoder, signal, spawnProcess, options = {}) {
  const decoder = spawnProcess('ffmpeg', decoderArgs(filePath), {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = captureStderr(decoder);
  const exit = waitForChild(decoder, `Audio decoder for ${filePath}`, stderr, signal);
  const abort = () => killChild(decoder);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const [pcmBytes] = await Promise.all([
      pump(decoder.stdout, encoder.stdin, signal, options),
      exit
    ]);
    return pcmBytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    killChild(decoder);
  }
}

async function streamEncodedInputs({
  req,
  res,
  source,
  inputs,
  signal,
  spawnProcess,
  pacingRuntime
}) {
  const encoder = spawnProcess('ffmpeg', encoderArgs(source.format), {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr = captureStderr(encoder);
  const exit = waitForChild(encoder, 'Continuous audio encoder', stderr, signal);
  const abort = () => killChild(encoder);
  signal?.addEventListener('abort', abort, { once: true });

  res.status(200);
  res.set({
    'Accept-Ranges': 'none',
    'Cache-Control': AUDIO_CACHE_CONTROL,
    'Content-Type': source.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    'X-Accel-Buffering': 'no'
  });
  if (source.servedTier) res.set('X-Served-Tier', source.servedTier);
  res.flushHeaders?.();

  const output = pumpOutput(
    encoder.stdout,
    res,
    signal,
    source.outputPacing,
    { format: source.format, ...pacingRuntime }
  );
  const skipState = {
    remaining: pcmBytesForSeconds(
      source.decodeStartOffsetSeconds ?? source.startOffsetSeconds
    )
  };
  const input = (async () => {
    for await (const inputItem of inputs) {
      const descriptor = typeof inputItem === 'string'
        ? { path: inputItem }
        : inputItem;
      const skipBefore = skipState.remaining;
      const pcmBytes = await decodeInto(descriptor.path, encoder, signal, spawnProcess, {
        skipState
      });
      const skippedPcmBytes = skipBefore - skipState.remaining;
      source.onInputDecoded?.(descriptor, pcmBytes, { skippedPcmBytes });
      if (descriptor.lastInChapter && descriptor.chapterIndex === source.chapterIndex) {
        // A chapter-relative resume must never consume audio from the next
        // chapter when a text-derived duration estimate was too long.
        skipState.remaining = 0;
      }
    }
    encoder.stdin.end();
  })();

  try {
    await Promise.all([input, output, exit]);
    if (!res.destroyed) res.end();
  } finally {
    signal?.removeEventListener('abort', abort);
    killChild(encoder);
    if (!encoder.stdin.destroyed) encoder.stdin.destroy();
  }
}

/**
 * Streams a chapter through one native-media HTTP response. The source owns
 * generation state; this module owns transport lifetime, backpressure, and
 * finalized-file fallback.
 */
function createChapterAudioStreamer({
  serveAudioFile,
  spawnProcess = spawn,
  pacingRuntime = {}
}) {
  if (typeof serveAudioFile !== 'function') {
    throw new TypeError('createChapterAudioStreamer requires serveAudioFile');
  }

  async function stream(req, res, source) {
    if (await existingNonEmptyFile(source.finalPath)) {
      return serveAudioFile(req, res, source.finalPath);
    }

    const controller = new AbortController();
    const disconnect = () => controller.abort();
    req.once('aborted', disconnect);
    res.once('close', disconnect);

    try {
      source.prioritize?.(0);
      const firstPath = await source.waitForChunk(0, controller.signal);

      // Chapter assembly can finish while the first chunk is generating. Use
      // it before committing progressive headers so Range remains available.
      if (await existingNonEmptyFile(source.finalPath)) {
        return serveAudioFile(req, res, source.finalPath);
      }

      async function* inputs() {
        yield firstPath;
        for (let index = 1; index < source.totalChunks; index++) {
          source.prioritize?.(index);
          yield await source.waitForChunk(index, controller.signal);
        }
      }
      await streamEncodedInputs({
        req,
        res,
        source,
        inputs: inputs(),
        signal: controller.signal,
        spawnProcess,
        pacingRuntime
      });
    } finally {
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  }

  async function streamContinuous(req, res, source) {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    try {
      await streamEncodedInputs({
        req,
        res,
        source,
        inputs: source.iterateInputs(controller.signal),
        signal: controller.signal,
        spawnProcess,
        pacingRuntime
      });
    } finally {
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  }

  return { stream, streamContinuous, isClientDisconnect };
}

module.exports = {
  captureStderr,
  createChapterAudioStreamer,
  createOutputPacer,
  decodeInto,
  isClientDisconnect,
  killChild,
  pcmBytesForSeconds,
  waitForChild
};
