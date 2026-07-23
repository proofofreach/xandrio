#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  DEFAULT_ENGINE_GAIN_DB,
  buildMasteringArgs,
  verifyAudioFile
} = require('../lib/audio-quality');

const execFileAsync = promisify(execFile);
const projectRoot = path.join(__dirname, '..');

function parseArgs(argv) {
  const files = [];
  let minimumDurationSeconds = 0;
  let calibrationFixtures = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-duration') {
      minimumDurationSeconds = Number(argv[++i]);
      if (!Number.isFinite(minimumDurationSeconds) || minimumDurationSeconds < 0) {
        throw new Error('--min-duration must be a non-negative number of seconds');
      }
    } else if (argv[i] === '--calibration-fixtures') {
      calibrationFixtures = true;
    } else {
      files.push(argv[i]);
    }
  }
  if (!files.length && !calibrationFixtures) {
    throw new Error('Usage: verify-audio-quality.js [--min-duration SECONDS] FILE... | --calibration-fixtures');
  }
  if (files.length && calibrationFixtures) throw new Error('--calibration-fixtures does not accept file arguments');
  return { files, minimumDurationSeconds, calibrationFixtures };
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function formatMeasurement(measurement) {
  return `${measurement.integratedLufs.toFixed(1)} LUFS, ${measurement.truePeakDb.toFixed(1)} dBTP, ` +
    `${measurement.loudnessRange.toFixed(1)} LU LRA, ${measurement.durationSeconds.toFixed(2)}s`;
}

async function verifyCalibrationFixtures() {
  const manifestPath = path.join(__dirname, 'audio-calibration-fixtures.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-audio-calibration-'));
  let failures = 0;
  try {
    for (const fixture of manifest.fixtures || []) {
      const sourcePath = path.resolve(projectRoot, fixture.source);
      const outputPath = path.join(tempDir, `${fixture.engine}.mp3`);
      try {
        const actualHash = await sha256(sourcePath);
        if (actualHash !== fixture.sha256) {
          throw new Error(`source hash ${actualHash} does not match manifest ${fixture.sha256}`);
        }
        if (DEFAULT_ENGINE_GAIN_DB[fixture.engine] !== fixture.gainDb) {
          throw new Error(`default gain ${DEFAULT_ENGINE_GAIN_DB[fixture.engine]} dB does not match calibrated ${fixture.gainDb} dB`);
        }
        await execFileAsync('ffmpeg', buildMasteringArgs({
          inputFormat: fixture.inputFormat,
          inputPath: sourcePath,
          outputPath,
          gainDb: fixture.gainDb
        }));
        const result = await verifyAudioFile(outputPath);
        if (!result.pass) throw new Error(result.issues.join('; '));
        console.log(`PASS ${fixture.engine}/${fixture.voice}: ${formatMeasurement(result.measurement)}`);
      } catch (err) {
        failures++;
        console.error(`FAIL ${fixture.engine || 'unknown'} calibration: ${err.message}`);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  return failures;
}

async function main() {
  const { files, minimumDurationSeconds, calibrationFixtures } = parseArgs(process.argv.slice(2));
  if (calibrationFixtures) {
    process.exitCode = await verifyCalibrationFixtures() ? 1 : 0;
    return;
  }
  let failures = 0;
  for (const file of files) {
    try {
      const result = await verifyAudioFile(file, { minimumDurationSeconds });
      const m = result.measurement;
      const summary = formatMeasurement(m);
      if (result.pass) {
        console.log(`PASS ${path.resolve(file)}: ${summary}`);
      } else {
        failures++;
        console.error(`FAIL ${path.resolve(file)}: ${summary}`);
        for (const issue of result.issues) console.error(`  - ${issue}`);
      }
    } catch (err) {
      failures++;
      console.error(`FAIL ${path.resolve(file)}: ${err.message}`);
    }
  }
  process.exitCode = failures ? 1 : 0;
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
