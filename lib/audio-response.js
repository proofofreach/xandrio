const crypto = require('crypto');
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
  const complete = err => {
    reportStreamFailure(err, readStream, audioPath);
    // A failed pipeline destroys the response without calling end(). The
    // request limiter retains its permit until backend work ends, so notify
    // it after pipeline cleanup even when the client has already disconnected.
    if (err && !res.writableEnded) res.end();
  };
  try {
    pipeline(readStream, res, complete);
  } catch (err) {
    complete(err);
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

// Chapter audio lives at fixed paths that pronunciation repair and chapter
// rebuilds replace in place. A file served without a content identity still
// needs a strong validator, or a Range request issued mid-playback splices
// bytes from two encodes. The opened descriptor's device, inode, size and
// nanosecond mtime change with every replacement (rename gives a new inode; an
// in-place write moves mtime), and they describe exactly the bytes served.
function fileValidator(stat) {
  const digest = crypto.createHash('sha256')
    .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`)
    .digest('hex')
    .slice(0, 32);
  return `"file-${digest}"`;
}

function lastModified(stat) {
  return new Date(Number(stat.mtimeMs)).toUTCString();
}

// RFC 9110 13.1.5: If-Range uses the strong comparison. An entity tag must
// match exactly and never as a weak tag. A date never matches: these files are
// rewritten in place, and two writes within one second share a Last-Modified
// value, so a date cannot prove the client holds the current bytes. The strong
// ETag does; a client with only a date gets the full current file.
function ifRangeMatches(ifRange, etag) {
  const validator = String(ifRange).trim();
  if (validator.startsWith('W/')) return false;
  return validator.startsWith('"') && validator === etag;
}

function artifactHeaders(identity, validator) {
  const headers = validator
    ? { 'ETag': validator.etag, 'Last-Modified': validator.lastModified }
    : {};
  if (!identity) return headers;
  return {
    ...headers,
    'ETag': identity.etag,
    'X-Xandrio-Artifact-SHA256': identity.artifactId
  };
}

async function serveAudioFile(req, res, audioPath, options = {}) {
  const handle = await fsp.open(audioPath, 'r');
  let handedOff = false;
  try {
    const stat = await handle.stat({ bigint: true });
    const fileSize = Number(stat.size);
    const identity = normalizedIdentity(options.identity, fileSize);
    const validator = {
      etag: identity?.etag || fileValidator(stat),
      lastModified: lastModified(stat)
    };
    const responseHeaders = artifactHeaders(identity, validator);
    const range = req.headers.range &&
      (!req.headers['if-range'] || ifRangeMatches(req.headers['if-range'], validator.etag))
      ? req.headers.range
      : null;

    if (range) {
      const parsedRange = parseAudioRange(range, fileSize);
      if (!parsedRange || parsedRange.invalid) {
        serveRangeNotSatisfiable(res, fileSize, responseHeaders);
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
        ...responseHeaders
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
      ...responseHeaders
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
