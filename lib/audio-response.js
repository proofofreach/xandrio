const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pipeline } = require('stream');

const AUDIO_CACHE_CONTROL = 'no-store';
const AUDIO_CONTENT_HASH_HEADER = 'X-Xandrio-Content-SHA256';
const MAX_CACHED_AUDIO_HASHES = 512;
const audioHashes = new Map();

async function audioContentHash(audioPath, stat, createReadStream) {
  if (!stat.isFile()) return '';
  const key = [
    audioPath,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs
  ].join('\0');
  if (audioHashes.has(key)) return audioHashes.get(key);
  const pending = (async () => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream()) hash.update(chunk);
    return `sha256-${hash.digest('hex')}`;
  })();
  audioHashes.set(key, pending);
  while (audioHashes.size > MAX_CACHED_AUDIO_HASHES) {
    audioHashes.delete(audioHashes.keys().next().value);
  }
  try {
    return await pending;
  } catch (error) {
    audioHashes.delete(key);
    throw error;
  }
}

function parseAudioRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return { invalid: true };

  let start;
  let end;

  if (match[1] === '' && match[2] === '') return { invalid: true };
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? fileSize - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fileSize) {
    return { invalid: true };
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

function serveRangeNotSatisfiable(res, fileSize) {
  res.writeHead(416, {
    'Content-Range': `bytes */${fileSize}`,
    'Accept-Ranges': 'bytes'
  });
  res.end();
}

function audioContentType(audioPath) {
  if (/\.(?:m4a|m4s|mp4)$/i.test(audioPath)) return 'audio/mp4';
  if (/\.ts$/i.test(audioPath)) return 'video/mp2t';
  if (/\.wav$/i.test(audioPath)) return 'audio/wav';
  return 'audio/mpeg';
}

// readStream.pipe(res) does not forward stream errors, so a read failure
// after the headers are out raises an unhandled 'error' event and takes the
// process down. That is a live risk here: the post-delete artifact sweeps and
// the TTS orphan cleaner can unlink chapter audio while a client is still
// streaming it. pipeline() routes the error to us and destroys both sides.
// A client that seeks, navigates away, locks the phone or simply closes the app
// aborts the response mid-flight. Every one of these is ordinary and none is a
// server fault. ERR_STREAM_UNABLE_TO_PIPE and ERR_STREAM_DESTROYED arise when
// the response was already torn down before or during the pipe — the same
// event, observed a moment earlier or later.
const CLIENT_DISCONNECT_CODES = new Set([
  'ERR_STREAM_PREMATURE_CLOSE',
  'ECONNRESET',
  'ERR_STREAM_UNABLE_TO_PIPE',
  'ERR_STREAM_DESTROYED',
  'EPIPE'
]);

function streamAudio(readStream, res, audioPath) {
  pipeline(readStream, res, (err) => {
    if (!err) return;
    if (CLIENT_DISCONNECT_CODES.has(err.code)) return;
    console.warn(`Audio stream failed for ${audioPath}: ${err.message}`);
  });
}

async function serveAudioFile(req, res, audioPath) {
  const offlineDownload = req.headers['x-xandrio-offline-download'] === '1';
  const range = req.headers.range;
  if (offlineDownload && !range) {
    const handle = await fsp.open(audioPath, 'r');
    let handedOff = false;
    try {
      const stat = await handle.stat();
      const contentHash = await audioContentHash(
        audioPath,
        stat,
        () => handle.createReadStream({ start: 0, autoClose: false })
      );
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Cache-Control': AUDIO_CACHE_CONTROL,
        'Content-Length': stat.size,
        'Content-Type': audioContentType(audioPath),
        [AUDIO_CONTENT_HASH_HEADER]: contentHash
      });
      const readStream = handle.createReadStream({ start: 0, autoClose: true });
      handedOff = true;
      streamAudio(readStream, res, audioPath);
      return;
    } finally {
      if (!handedOff) await handle.close().catch(() => {});
    }
  }

  const stat = await fsp.stat(audioPath);
  const fileSize = stat.size;

  if (range) {
    const parsedRange = parseAudioRange(range, fileSize);
    if (!parsedRange || parsedRange.invalid) {
      serveRangeNotSatisfiable(res, fileSize);
      return;
    }

    const { start, end } = parsedRange;
    const chunkSize = (end - start) + 1;
    const readStream = fs.createReadStream(audioPath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': AUDIO_CACHE_CONTROL,
      'Content-Length': chunkSize,
      'Content-Type': audioContentType(audioPath)
    });
    streamAudio(readStream, res, audioPath);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Cache-Control': AUDIO_CACHE_CONTROL,
    'Content-Length': fileSize,
    'Content-Type': audioContentType(audioPath)
  });
  streamAudio(fs.createReadStream(audioPath), res, audioPath);
}

module.exports = {
  parseAudioRange,
  serveAudioFile,
  serveRangeNotSatisfiable,
  audioContentType
};
