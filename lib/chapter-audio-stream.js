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

// Bytes per MP3 frame on the live transport. Every byte after the stream
// header is CBR frames, so a byte offset maps to a time on the frame grid. At
// the mastering policy (24 kHz, MPEG-2 LSF, 576 samples per frame) the frame
// size is 72 * bitrate / sampleRate; for 160 kbps that is exactly 480 bytes
// with no padding, so 20 000 bytes is exactly one second.
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

function syncsafeInt(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21)
    | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7)
    | (buffer[offset + 3] & 0x7f);
}

/**
 * Byte length of the stream header ffmpeg writes before the first audio
 * frame: an ID3v2 tag (its length depends on the ffmpeg version string) and
 * the Xing/Info frame (one CBR frame). Parsed from `buffer`, the start of an
 * encoded response; null when the layout is not recognised.
 */
function parseMp3HeaderBytes(buffer) {
  if (!buffer || buffer.length < 10) return null;
  let offset = 0;
  if (buffer.toString('latin1', 0, 3) === 'ID3') {
    offset = 10 + syncsafeInt(buffer, 6) + ((buffer[5] & 0x10) ? 10 : 0);
  }
  const frameBytes = mp3FrameBytes();
  if (buffer.length < offset + frameBytes) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;
  const firstFrame = buffer.toString('latin1', offset, offset + frameBytes);
  if (firstFrame.includes('Xing') || firstFrame.includes('Info')) offset += frameBytes;
  if (buffer.length >= offset + 2
    && (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0)) return null;
  return offset;
}

// A probe that never closes (a wedged ffmpeg under load) must not hold every
// reconnect that waits on it.
const HEADER_PROBE_TIMEOUT_MS = 10 * 1000;

/**
 * Measure the transport header by encoding a few frames of silence with the
 * same encoder arguments the live response uses. Null when it fails.
 */
function measureMp3HeaderBytes(spawnProcess = spawn, { timeoutMs = HEADER_PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let encoder;
    try {
      encoder = spawnProcess('ffmpeg', encoderArgs('mp3'), { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      killChild(encoder);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    const finish = value => {
      clearTimeout(timer);
      resolve(value);
    };
    const chunks = [];
    encoder.stdout.on('data', chunk => chunks.push(chunk));
    encoder.on('error', () => finish(null));
    encoder.on('close', () => finish(parseMp3HeaderBytes(Buffer.concat(chunks))));
    encoder.stdin.on('error', () => {});
    // Half a second of silence: enough for the header and several frames.
    encoder.stdin.end(Buffer.alloc(pcmBytesForSeconds(0.5)));
  });
}

const RECONNECT_RANGE = /^\s*bytes=(\d+)-\s*$/;

/**
 * True for the request shape a browser sends after a dropped connection:
 * an open-ended `Range: bytes=N-` with N > 0.
 */
function isReconnectRange(rangeHeader) {
  const match = typeof rangeHeader === 'string' ? RECONNECT_RANGE.exec(rangeHeader) : null;
  return Boolean(match) && Number(match[1]) > 0;
}

/**
 * Map an open-ended `Range: bytes=N-` on the continuous MP3 transport to a
 * time offset in the stream, so a browser that lost its connection can
 * resume from the byte it already has instead of re-reading from the start.
 *
 * Chromium sends `Range: bytes=<bytes received>-` after a dropped connection
 * even when the first response said `Accept-Ranges: none`. A 200 answer makes
 * it download and discard everything before that position — at paced output
 * that is minutes of silence. Only that shape resumes. Everything else (no
 * Range, `bytes=0-`, Safari's bounded `bytes=0-1` probe, suffix ranges) is
 * served exactly as before: a 200 with the full stream from the offset.
 *
 * `headerBytes` is the ID3 + Xing prefix of the first response, which the
 * browser's byte count includes; `measureMp3HeaderBytes` provides it.
 *
 * @returns {{firstByte:number,seconds:number}|null}
 */
function planResumeFromRange(rangeHeader, format = 'mp3', headerBytes = 0) {
  if (format !== 'mp3' || typeof rangeHeader !== 'string') return null;
  if (!Number.isSafeInteger(headerBytes) || headerBytes < 0) return null;
  const match = RECONNECT_RANGE.exec(rangeHeader);
  if (!match) return null;
  const requestedFirst = Number(match[1]);
  if (!Number.isSafeInteger(requestedFirst) || requestedFirst === 0) return null;
  const frameBytes = mp3FrameBytes();
  // Inside the header, or the first frame: the full stream is cheaper than a
  // resumed encode and the browser discards those few bytes itself.
  if (requestedFirst < headerBytes + frameBytes) return null;
  // Snap down to the frame grid: the browser discards the few bytes between
  // the snapped start and the position it asked for, and the first byte it
  // keeps is a frame header, so the decoder resynchronises immediately.
  const firstByte = headerBytes + Math.floor((requestedFirst - headerBytes) / frameBytes) * frameBytes;
  const seconds = (firstByte - headerBytes) / encodedBytesPerSecond('mp3');
  if (seconds > RESUME_RANGE_HORIZON_SECONDS) return null;
  return { firstByte, seconds };
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

function encoderArgs(format, { headerless = false } = {}) {
  // A resumed response is spliced into the middle of a stream the browser
  // already holds, so it carries no ID3 tag and no Xing/Info frame. The first
  // response keeps ffmpeg's default header: that is what every client,
  // including iOS Safari, has always received.
  const output = format === 'wav'
    ? ['-c:a', 'pcm_s16le', '-f', 'wav']
    : [
        '-c:a', 'libmp3lame', '-b:a', getMasteringBitrate(), '-f', 'mp3',
        ...(headerless ? ['-write_xing', '0', '-id3v2_version', '0'] : [])
      ];
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

// Headers of an encoded response that starts at its first byte.
function firstResponseHeaders(format) {
  return {
    'Accept-Ranges': 'none',
    'Cache-Control': AUDIO_CACHE_CONTROL,
    'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    'X-Accel-Buffering': 'no'
  };
}

/**
 * Answer HEAD on an encoded transport with the headers a GET would get.
 * Without this, Express runs HEAD through the GET handler, which waits for
 * narration and runs the whole paced encode only to discard the body.
 */
function sendEncodedHead(res, source = {}) {
  res.status(200);
  res.set(firstResponseHeaders(source.format));
  if (source.servedTier) res.set('X-Served-Tier', source.servedTier);
  res.end();
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
  // Only an open-ended `Range: bytes=N-` reconnect on a resumable MP3 source
  // is answered with 206 from the time byte N maps to (planResumeFromRange).
  // The browser splices the new bytes at N in its own buffer, so stream time,
  // and with it the chapter position the client derives from it, is unchanged
  // across the reconnect. Every other request gets the unchanged 200 response.
  const resume = source.resumable === true && source.format === 'mp3' && source.resume
    ? source.resume
    : null;
  const encoder = spawnProcess('ffmpeg', encoderArgs(source.format, { headerless: Boolean(resume) }), {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr = captureStderr(encoder);
  const exit = waitForChild(encoder, 'Continuous audio encoder', stderr, signal);
  const abort = () => killChild(encoder);
  signal?.addEventListener('abort', abort, { once: true });

  if (resume) {
    res.status(206);
    res.set({
      'Accept-Ranges': 'bytes',
      'Cache-Control': AUDIO_CACHE_CONTROL,
      'Content-Range': `bytes ${resume.firstByte}-${resume.firstByte + RESUME_RANGE_HORIZON_SECONDS * encodedBytesPerSecond('mp3')}/*`,
      'Content-Type': 'audio/mpeg',
      'X-Accel-Buffering': 'no'
    });
  } else {
    res.status(200);
    res.set(firstResponseHeaders(source.format));
  }
  if (source.servedTier) res.set('X-Served-Tier', source.servedTier);
  res.flushHeaders?.();

  const output = pumpOutput(
    encoder.stdout,
    res,
    signal,
    source.outputPacing,
    { format: source.format, ...pacingRuntime }
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
// A failed header probe is retried after this delay, doubling to the cap.
// Caching the failure would disable resume until the next restart.
const HEADER_PROBE_RETRY_MS = 5 * 1000;
const HEADER_PROBE_MAX_RETRY_MS = 5 * 60 * 1000;

function createChapterAudioStreamer({
  serveAudioFile,
  spawnProcess = spawn,
  pacingRuntime = {},
  now = Date.now
}) {
  if (typeof serveAudioFile !== 'function') {
    throw new TypeError('createChapterAudioStreamer requires serveAudioFile');
  }

  async function stream(req, res, source) {
    if (await existingNonEmptyFile(source.finalPath)) {
      return serveAudioFile(req, res, source.finalPath);
    }
    if (req.method === 'HEAD') return sendEncodedHead(res, source);

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

  let measuredHeaderBytes = null;
  let headerProbe = null;
  let headerRetryAt = 0;
  let headerRetryDelayMs = HEADER_PROBE_RETRY_MS;
  /**
   * ID3 + Xing prefix length of a first response. A success is kept for the
   * process; a failure (spawn under load) is retried with backoff.
   */
  function transportHeaderBytes() {
    if (measuredHeaderBytes !== null) return Promise.resolve(measuredHeaderBytes);
    if (headerProbe) return headerProbe;
    if (now() < headerRetryAt) return Promise.resolve(null);
    headerProbe = measureMp3HeaderBytes(spawnProcess).catch(() => null).then(bytes => {
      headerProbe = null;
      if (bytes === null) {
        headerRetryAt = now() + headerRetryDelayMs;
        headerRetryDelayMs = Math.min(headerRetryDelayMs * 2, HEADER_PROBE_MAX_RETRY_MS);
      } else {
        measuredHeaderBytes = bytes;
      }
      return bytes;
    });
    return headerProbe;
  }

  /**
   * Resume plan for a request on the continuous transport, or null for the
   * ordinary full response. A reconnect that cannot be planned (the header
   * could not be measured) is `{ unavailable: true }`: a wrong splice point
   * would be worse than a re-read, and a re-read is worse than a reload.
   */
  async function planResume(req) {
    const range = req?.headers?.range;
    if (!isReconnectRange(range)) return null;
    const headerBytes = await transportHeaderBytes();
    if (headerBytes === null) return { unavailable: true };
    return planResumeFromRange(range, 'mp3', headerBytes);
  }

  async function streamContinuous(req, res, source) {
    if (req.method === 'HEAD') return sendEncodedHead(res, source);
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
        spawnProcess,
        pacingRuntime
      });
    } finally {
      controller.abort();
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  }

  return {
    stream,
    streamContinuous,
    isClientDisconnect,
    planResume,
    transportHeaderBytes,
    sendHead: sendEncodedHead
  };
}

module.exports = {
  captureStderr,
  createChapterAudioStreamer,
  createOutputPacer,
  decodeInto,
  isClientDisconnect,
  isReconnectRange,
  killChild,
  measureMp3HeaderBytes,
  mp3FrameBytes,
  parseMp3HeaderBytes,
  pcmBytesForSeconds,
  planResumeFromRange,
  waitForChild
};
