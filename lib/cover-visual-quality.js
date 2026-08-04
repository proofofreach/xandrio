const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 64;
const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;

function measureGrayscaleFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length !== SAMPLE_BYTES) return null;

  let sum = 0;
  for (const value of frame) sum += value;
  const mean = sum / frame.length;

  let variance = 0;
  for (const value of frame) {
    variance += (value - mean) ** 2;
  }

  let gradientTotal = 0;
  let gradientCount = 0;
  let edgeCount = 0;
  for (let y = 0; y < SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const index = (y * SAMPLE_WIDTH) + x;
      if (x > 0) {
        const gradient = Math.abs(frame[index] - frame[index - 1]);
        gradientTotal += gradient;
        edgeCount += gradient >= 16 ? 1 : 0;
        gradientCount += 1;
      }
      if (y > 0) {
        const gradient = Math.abs(frame[index] - frame[index - SAMPLE_WIDTH]);
        gradientTotal += gradient;
        edgeCount += gradient >= 16 ? 1 : 0;
        gradientCount += 1;
      }
    }
  }

  const ordered = [...frame].sort((a, b) => a - b);
  const percentile = fraction => ordered[Math.floor((ordered.length - 1) * fraction)];
  const standardDeviation = Math.sqrt(variance / frame.length);
  const meanGradient = gradientTotal / gradientCount;
  const edgeFraction = edgeCount / gradientCount;
  const dynamicRange = percentile(0.95) - percentile(0.05);

  return {
    standardDeviation,
    meanGradient,
    edgeFraction,
    dynamicRange,
    lowInformation: edgeFraction < 0.015 && meanGradient < 3 && dynamicRange < 40
  };
}

async function inspectCoverVisualQuality(filePath, options = {}) {
  const run = options.execFileImpl || execFileAsync;
  try {
    const { stdout } = await run('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', filePath,
      '-vf', `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}:flags=area,format=gray`,
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1'
    ], {
      encoding: null,
      timeout: 5000,
      maxBuffer: SAMPLE_BYTES * 2,
      windowsHide: true
    });
    const metrics = measureGrayscaleFrame(stdout);
    return metrics ? { status: 'measured', ...metrics } : { status: 'unknown', lowInformation: false };
  } catch {
    // Cover delivery must remain available if the optional visual probe fails.
    return { status: 'unknown', lowInformation: false };
  }
}

module.exports = {
  inspectCoverVisualQuality,
  measureGrayscaleFrame,
  SAMPLE_WIDTH,
  SAMPLE_HEIGHT
};
