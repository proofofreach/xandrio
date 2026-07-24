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

function serveRangeNotSatisfiable(res, fileSize) {
  res.writeHead(416, {
    'Content-Range': `bytes */${fileSize}`,
    'Accept-Ranges': 'bytes'
  });
  res.end();
}

function audioContentType(audioPath) {
  if (/\.m4a$/i.test(audioPath)) return 'audio/mp4';
  if (/\.wav$/i.test(audioPath)) return 'audio/wav';
  return 'audio/mpeg';
}

// readStream.pipe(res) does not forward stream errors, so a read failure
// after the headers are out raises an unhandled 'error' event and takes the
// process down. That is a live risk here: the post-delete artifact sweeps and
// the TTS orphan cleaner can unlink chapter audio while a client is still
// streaming it. pipeline() routes the error to us and destroys both sides.
function streamAudio(readStream, res, audioPath) {
  pipeline(readStream, res, (err) => {
    if (!err) return;
    // A client that seeks or navigates away aborts the response mid-flight;
    // that is normal and not worth logging as a failure.
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET' || res.destroyed) return;
    console.warn(`Audio stream failed for ${audioPath}: ${err.message}`);
  });
}

async function serveAudioFile(req, res, audioPath) {
  const stat = await fsp.stat(audioPath);
  const fileSize = stat.size;
  const range = req.headers.range;

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
