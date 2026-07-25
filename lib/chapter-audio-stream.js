'use strict';

const fs = require('fs');
const fsp = fs.promises;

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

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
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
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted || res.destroyed) onAbort();
  });
}

async function existingNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    return (await fsp.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

async function appendFile(filePath, res, signal, options = {}) {
  const readStream = fs.createReadStream(filePath, options);
  const abort = () => readStream.destroy(clientDisconnectError());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of readStream) {
      if (signal?.aborted || res.destroyed) abort();
      if (!res.write(chunk)) {
        await waitForDrain(res, signal);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    readStream.destroy();
  }
}

async function writeBuffer(buffer, res, signal) {
  if (signal?.aborted || res.destroyed) {
    throw clientDisconnectError();
  }
  if (!res.write(buffer)) {
    await waitForDrain(res, signal);
  }
}

async function inspectWav(filePath) {
  const stat = await fsp.stat(filePath);
  const probeSize = Math.min(stat.size, 1024 * 1024);
  const handle = await fsp.open(filePath, 'r');
  let probe;
  try {
    probe = Buffer.alloc(probeSize);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    probe = probe.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  if (probe.length < 12 ||
      probe.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      probe.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Generated WAV chunk has an invalid RIFF header');
  }

  let offset = 12;
  let format = null;
  let dataOffset = null;
  let dataSize = null;
  while (offset + 8 <= probe.length) {
    const id = probe.subarray(offset, offset + 4).toString('ascii');
    const size = probe.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || payloadOffset + size > probe.length) {
        throw new Error('Generated WAV chunk has an invalid format block');
      }
      format = Buffer.from(probe.subarray(payloadOffset, payloadOffset + size));
    }
    if (id === 'data') {
      dataOffset = payloadOffset;
      dataSize = Math.min(size, Math.max(0, stat.size - dataOffset));
      break;
    }
    offset = payloadOffset + size + (size % 2);
  }

  if (!format || dataOffset === null || dataSize === null) {
    throw new Error('Generated WAV chunk has no readable audio payload');
  }
  return { format, dataOffset, dataSize };
}

function streamingWavHeader(format) {
  const paddedFormatLength = format.length + (format.length % 2);
  const header = Buffer.alloc(12 + 8 + paddedFormatLength + 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(format.length, 16);
  format.copy(header, 20);
  const dataHeaderOffset = 20 + paddedFormatLength;
  header.write('data', dataHeaderOffset);
  header.writeUInt32LE(0xffffffff, dataHeaderOffset + 4);
  return header;
}

async function appendWavPayload(filePath, expectedFormat, res, signal) {
  const wav = await inspectWav(filePath);
  if (!wav.format.equals(expectedFormat)) {
    throw new Error('Generated WAV chunks use incompatible audio formats');
  }
  if (wav.dataSize === 0) throw new Error('Generated WAV chunk is empty');
  return appendFile(filePath, res, signal, {
    start: wav.dataOffset,
    end: wav.dataOffset + wav.dataSize - 1
  });
}

/**
 * Streams a chapter through one native-media HTTP response. The source owns
 * generation state; this module owns transport lifetime, backpressure, and
 * finalized-file fallback.
 */
function createChapterAudioStreamer({ serveAudioFile }) {
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

      const firstWav = source.format === 'wav' ? await inspectWav(firstPath) : null;
      res.status(200);
      res.set({
        'Accept-Ranges': 'none',
        'Cache-Control': AUDIO_CACHE_CONTROL,
        'Content-Type': source.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        'X-Accel-Buffering': 'no'
      });
      if (source.servedTier) res.set('X-Served-Tier', source.servedTier);
      res.flushHeaders?.();

      if (firstWav) {
        await writeBuffer(streamingWavHeader(firstWav.format), res, controller.signal);
        await appendFile(firstPath, res, controller.signal, {
          start: firstWav.dataOffset,
          end: firstWav.dataOffset + firstWav.dataSize - 1
        });
      } else {
        await appendFile(firstPath, res, controller.signal);
      }
      for (let index = 1; index < source.totalChunks; index++) {
        source.prioritize?.(index);
        const chunkPath = await source.waitForChunk(index, controller.signal);
        if (firstWav) {
          await appendWavPayload(chunkPath, firstWav.format, res, controller.signal);
        } else {
          await appendFile(chunkPath, res, controller.signal);
        }
      }
      res.end();
    } finally {
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  }

  return { stream, isClientDisconnect };
}

module.exports = {
  createChapterAudioStreamer,
  isClientDisconnect,
  inspectWav,
  streamingWavHeader
};
