const fs = require('fs');
const fsp = fs.promises;

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
    readStream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Cache-Control': AUDIO_CACHE_CONTROL,
    'Content-Length': fileSize,
    'Content-Type': audioContentType(audioPath)
  });
  fs.createReadStream(audioPath).pipe(res);
}

module.exports = {
  parseAudioRange,
  serveAudioFile,
  serveRangeNotSatisfiable,
  audioContentType
};
