const fs = require('fs');
const fsp = fs.promises;
const { pipeline } = require('stream');

const AUDIO_CACHE_CONTROL = 'no-store';

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

function serveRangeNotSatisfiable(res, fileSize, headers = {}) {
  res.writeHead(416, {
    'Content-Range': `bytes */${fileSize}`,
    'Accept-Ranges': 'bytes',
    ...headers
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

function reportStreamFailure(err, readStream, audioPath) {
  if (!err) return;
  // The read side is ours to close. pipeline() only destroys it when it got
  // far enough to own it; a synchronous rejection leaves the file handle open.
  if (!readStream.destroyed) readStream.destroy();
  if (CLIENT_DISCONNECT_CODES.has(err.code)) return;
  console.warn(`Audio stream failed for ${audioPath}: ${err.message}`);
}

function streamAudio(readStream, res, audioPath) {
  // pipeline() reports most failures through its callback, but an already
  // destroyed destination makes it *throw* ERR_STREAM_UNABLE_TO_PIPE
  // synchronously — past the callback, out through the route handler, and into
  // the logs as a server error. That is the ordinary iOS case of a listener
  // locking the phone or closing the app mid-request. Both paths converge here.
  try {
    pipeline(readStream, res, err => reportStreamFailure(err, readStream, audioPath));
  } catch (err) {
    reportStreamFailure(err, readStream, audioPath);
  }
}

function normalizedIdentity(identity, fileSize) {
  if (!identity) return null;
  const artifactId = String(identity.artifactId || identity.contentHash || '');
  if (!/^sha256-[a-f0-9]{64}$/.test(artifactId)) {
    throw new TypeError('Invalid audio artifact identity');
  }
  if (Number(identity.size) !== fileSize) {
    throw new Error('Audio artifact identity size does not match the opened file');
  }
  const etag = String(identity.etag || `"${artifactId}"`);
  if (etag !== `"${artifactId}"`) throw new TypeError('Invalid audio artifact ETag');
  return { artifactId, etag };
}

function artifactHeaders(identity) {
  if (!identity) return {};
  return {
    'ETag': identity.etag,
    'X-Xandrio-Artifact-SHA256': identity.artifactId
  };
}

async function serveAudioFile(req, res, audioPath, options = {}) {
  const handle = await fsp.open(audioPath, 'r');
  let handedOff = false;
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    const identity = normalizedIdentity(options.identity, fileSize);
    const range = req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === identity?.etag)
      ? req.headers.range
      : null;

    if (range) {
      const parsedRange = parseAudioRange(range, fileSize);
      if (!parsedRange || parsedRange.invalid) {
        serveRangeNotSatisfiable(res, fileSize, artifactHeaders(identity));
        return;
      }

      const { start, end } = parsedRange;
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': AUDIO_CACHE_CONTROL,
        'Content-Length': chunkSize,
        'Content-Type': audioContentType(audioPath),
        ...artifactHeaders(identity)
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const readStream = handle.createReadStream({ start, end, autoClose: true });
      handedOff = true;
      streamAudio(readStream, res, audioPath);
      return;
    }

    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': AUDIO_CACHE_CONTROL,
      'Content-Length': fileSize,
      'Content-Type': audioContentType(audioPath),
      ...artifactHeaders(identity)
    };
    if (identity) headers['X-Xandrio-Content-SHA256'] = identity.artifactId;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const readStream = handle.createReadStream({ autoClose: true });
    handedOff = true;
    streamAudio(readStream, res, audioPath);
  } finally {
    if (!handedOff) await handle.close().catch(() => {});
  }
}

module.exports = {
  parseAudioRange,
  serveAudioFile,
  serveRangeNotSatisfiable,
  audioContentType,
  normalizedIdentity
};
