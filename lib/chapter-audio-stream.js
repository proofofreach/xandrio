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

// Bytes per MP3 frame on the live transport. The encoder below writes no
// ID3v2 tag and no Xing/Info frame, so the response is nothing but CBR frames
// from byte 0 and every byte offset maps to a time on the frame grid. At the
// mastering policy (24 kHz, MPEG-2 LSF, 576 samples per frame) the frame size
// is 72 * bitrate / sampleRate; for 160 kbps that is exactly 480 bytes with
// no padding, so 20 000 bytes is exactly one second.
function mp3FrameBytes() {
  const bitrate = encodedBytesPerSecond('mp3') * 8;
  const samplesPerFrame = MASTERING_POLICY.sampleRate <= 24000 ? 576 : 1152;
  return Math.floor(samplesPerFrame * bitrate / 8 / MASTERING_POLICY.sampleRate);
}

// Upper bound used as the last-byte-pos of a resumed response. A live encode
// has no known length; HTTP needs a last-byte-pos in Content-Range, and
// clients accept "*" only for the complete length. 24 hours matches the
// route's offset clamp (lib/routes/playback-routes.js startOffsetSeconds).
const RESUME_RANGE_HORIZON_SECONDS = 24 * 60 * 60;

/**
 * Map a `Range` request header on the continuous MP3 transport to a time
 * offset in the stream, so a browser that lost its connection can resume
 * from the byte it already has instead of re-reading from the start.
 *
 * Chromium always sends `Range: bytes=0-` and, after a dropped connection,
 * `Range: bytes=<bytes received>-`. A 200 answer to the latter makes it
 * download and discard everything before that position — at paced output
 * that is minutes of silence. Returns null when the request should be served
 * as an ordinary 200 (no Range, `bytes=0-`, suffix or malformed ranges).
 *
 * @returns {{firstByte:number,lastByte:number|null,seconds:number}|null}
 */
function planResumeFromRange(rangeHeader, format = 'mp3') {
  if (format !== 'mp3' || typeof rangeHeader !== 'string') return null;
  const match = /^\s*bytes=(\d+)-(\d*)\s*$/.exec(rangeHeader);
  if (!match) return null;
  const requestedFirst = Number(match[1]);
  const lastByte = match[2] === '' ? null : Number(match[2]);
  if (!Number.isSafeInteger(requestedFirst)) return null;
  if (lastByte !== null && (!Number.isSafeInteger(lastByte) || lastByte < requestedFirst)) return null;
  if (requestedFirst === 0 && lastByte === null) return null;
  const frameBytes = mp3FrameBytes();
  // Snap down to the frame grid: the browser discards the few bytes between
  // the snapped start and the position it asked for, and the first byte it
  // keeps is a frame header, so the decoder resynchronises immediately.
  const firstByte = Math.floor(requestedFirst / frameBytes) * frameBytes;
  const seconds = firstByte / encodedBytesPerSecond('mp3');
  if (seconds > RESUME_RANGE_HORIZON_SECONDS) return null;
  return { firstByte, lastByte, seconds };
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

async function pumpOutput(readable, writable, signal, pacing, pacingRuntime, options = {}) {
  const pace = pacing
    ? createOutputPacer({ ...pacing, ...pacingRuntime })
    : null;
  let remaining = Number.isSafeInteger(options.byteLimit) ? options.byteLimit : Infinity;
  for await (const chunk of readable) {
    const output = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    if (pace) await pace(output.length);
    await writeToStream(writable, output, signal);
    remaining -= output.length;
    if (remaining <= 0) {
      // A bounded range (a WebKit `bytes=0-1` probe, for instance) is
      // complete. End the response; the caller reaps the encoder.
      options.onLimitReached?.();
      return;
    }
  }
}

function encoderArgs(format) {
  // No ID3v2 tag and no Xing/Info frame: a live response cannot fill them in
  // anyway, and without them the stream is pure CBR frames from byte 0, which
  // is what lets planResumeFromRange() map a byte offset to a time.
  const output = format === 'wav'
    ? ['-c:a', 'pcm_s16le', '-f', 'wav']
    : ['-c:a', 'libmp3lame', '-b:a', getMasteringBitrate(), '-f', 'mp3', '-write_xing', '0', '-id3v2_version', '0'];
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

function decoderArgs(filePath, startSeconds = 0) {
  return [
    '-hide_banner', '-loglevel', 'error', '-xerror', '-nostdin',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
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
  if (signal?.aborted) throw clientDisconnectError();
  const skipBefore = options.skipState?.remaining || 0;
  // Finalized files can seek at the demuxer instead of decoding the entire
  // chapter prefix. Decode one second of preroll so MP3's bit reservoir and
  // decoder state settle before the first audible sample. Keep all offsets
  // on the same PCM-frame grid used by the discard path and timeline.
  const inputSkipBytes = options.seekable
    ? Math.max(0, skipBefore - pcmBytesForSeconds(1))
    : 0;
  const inputSkipSeconds = inputSkipBytes /
    (MASTERING_POLICY.sampleRate * MASTERING_POLICY.channels * 2);
  const decoder = spawnProcess('ffmpeg', decoderArgs(filePath, inputSkipSeconds), {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = captureStderr(decoder);
  const exit = waitForChild(decoder, `Audio decoder for ${filePath}`, stderr, signal);
  const abort = () => killChild(decoder);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  if (inputSkipBytes > 0) options.skipState.remaining -= inputSkipBytes;
  let pcmBytes;
  try {
    [pcmBytes] = await Promise.all([
      pump(decoder.stdout, encoder.stdin, signal, options),
      exit
    ]);
  } finally {
    signal?.removeEventListener('abort', abort);
    killChild(decoder);
  }
  if (inputSkipBytes > 0 && pcmBytes === 0) {
    // An estimated offset at/past EOF must account for the actual chapter
    // length, never invent skipped samples or consume the following chapter.
    // No PCM was emitted, so the conservative decode can safely retry once.
    options.skipState.remaining = skipBefore;
    return decodeInto(filePath, encoder, signal, spawnProcess, { ...options, seekable: false });
  }
  return pcmBytes;
}

async function streamEncodedInputs({
  req,
  res,
  source,
  inputs,
  signal,
  cancel,
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

  // A resumable source answers `Range: bytes=N-` with 206 from the time that
  // byte N maps to (planResumeFromRange). The browser splices the new bytes at
  // N in its own buffer, so stream time, and with it the chapter position the
  // client derives from it, is unchanged across the reconnect. Sources that
  // cannot resume keep advertising `Accept-Ranges: none` so a browser never
  // expects a 206 from them.
  const resume = source.resumable && source.resume ? source.resume : null;
  const resumable = source.resumable === true && source.format === 'mp3';
  const headers = {
    'Accept-Ranges': resumable ? 'bytes' : 'none',
    'Cache-Control': AUDIO_CACHE_CONTROL,
    'Content-Type': source.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    'X-Accel-Buffering': 'no'
  };
  let byteLimit = null;
  if (resume) {
    const lastByte = resume.lastByte ?? (
      resume.firstByte + RESUME_RANGE_HORIZON_SECONDS * encodedBytesPerSecond('mp3')
    );
    headers['Content-Range'] = `bytes ${resume.firstByte}-${lastByte}/*`;
    if (resume.lastByte !== null && resume.lastByte !== undefined) {
      byteLimit = resume.lastByte - resume.firstByte + 1;
    }
    res.status(206);
  } else {
    res.status(200);
  }
  res.set(headers);
  if (source.servedTier) res.set('X-Served-Tier', source.servedTier);
  res.flushHeaders?.();

  const output = pumpOutput(
    encoder.stdout,
    res,
    signal,
    source.outputPacing,
    { format: source.format, ...pacingRuntime },
    {
      byteLimit,
      onLimitReached: () => {
        if (!res.destroyed && !res.writableEnded) res.end();
        // Unwind the decode/encode pipeline the same way a client disconnect
        // does; the response itself is already complete.
        cancel?.();
      }
    }
  );
  // The decode start already includes the resumed seconds when the source was
  // prepared with them (the orchestrator picks the right chunk); otherwise skip
  // the resumed audio here.
  const skipState = {
    remaining: pcmBytesForSeconds(
      (source.decodeStartOffsetSeconds ?? source.startOffsetSeconds)
      + (resume && !source.resumeAppliedToDecodeStart ? resume.seconds : 0)
    )
  };
  const input = (async () => {
    for await (const inputItem of inputs) {
      const descriptor = typeof inputItem === 'string'
        ? { path: inputItem }
        : inputItem;
      const skipBefore = skipState.remaining;
      const pcmBytes = await decodeInto(descriptor.path, encoder, signal, spawnProcess, {
        skipState,
        seekable: descriptor.seekable === true
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
      if (req.aborted || res.destroyed) throw clientDisconnectError();
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
        cancel: () => controller.abort(),
        spawnProcess,
        pacingRuntime
      });
    } finally {
      // Encoder/output failure can finish Promise.all while the input iterator
      // is still waiting for narration. Cancel it before detaching the socket.
      controller.abort();
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
      if (req.aborted || res.destroyed) throw clientDisconnectError();
      await streamEncodedInputs({
        req,
        res,
        source,
        inputs: source.iterateInputs(controller.signal),
        signal: controller.signal,
        cancel: () => controller.abort(),
        spawnProcess,
        pacingRuntime
      });
    } finally {
      controller.abort();
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
  mp3FrameBytes,
  pcmBytesForSeconds,
  planResumeFromRange,
  waitForChild
};
