const { execFile } = require('child_process');

const MASTERING_POLICY = Object.freeze({
  integratedLufs: -18,
  truePeakDb: -1.5,
  loudnessRange: 11,
  sampleRate: 24000,
  channels: 1,
  bitrate: '160k',
  loudnessTolerance: 2,
  maximumTruePeakDb: -0.5,
  maximumLoudnessRange: 18
});

// Fixed gains avoid independent short-chunk loudnorm decisions (audible
// pumping). Defaults come from the checked-in July 2026 reference samples;
// environment overrides allow recalibration without code changes.
const DEFAULT_ENGINE_GAIN_DB = Object.freeze({ edge: 3, kokoro: 9.5, chatterbox: 2.5 });

function masteringGainForEngine(engineId, env = process.env) {
  const id = Object.hasOwn(DEFAULT_ENGINE_GAIN_DB, engineId) ? engineId : 'edge';
  const configured = Number(env[`${id.toUpperCase()}_MASTERING_GAIN_DB`]);
  return Number.isFinite(configured) ? configured : DEFAULT_ENGINE_GAIN_DB[id];
}

function getMasteringBitrate(env = process.env) {
  const value = String(env.TTS_MP3_BITRATE || env.AUDIO_MP3_BITRATE || MASTERING_POLICY.bitrate).trim().toLowerCase();
  const match = value.match(/^([1-9]\d{1,2})k$/);
  if (match) {
    const kbps = Number(match[1]);
    if (kbps >= 8 && kbps <= 160) return value;
  }
  return MASTERING_POLICY.bitrate;
}

function masteringOutputFormat(outputFormat, outputPath) {
  const normalized = String(outputFormat || '').trim().toLowerCase();
  if (normalized === 'wav' || /\.wav$/i.test(String(outputPath || ''))) return 'wav';
  return 'mp3';
}

function buildMasteringArgs({ inputFormat = 'wav', inputPath = 'pipe:0', outputPath, outputFormat = null, padEndMs = 0, gainDb = 0 } = {}) {
  if (!['wav', 'mp3'].includes(inputFormat)) throw new Error(`Unsupported mastering input format: ${inputFormat}`);
  if (!outputPath) throw new Error('Mastering output path is required');
  const masteredFormat = masteringOutputFormat(outputFormat, outputPath);

  const filters = [
    'silenceremove=start_periods=1:start_silence=0.10:start_threshold=-45dB',
    'areverse',
    'silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB',
    'areverse',
    `volume=${Number(gainDb).toFixed(2)}dB`,
    'alimiter=limit=0.750:attack=5:release=50:level=false'
  ];
  if (padEndMs > 0) filters.push(`apad=pad_dur=${(padEndMs / 1000).toFixed(3)}`);
  filters.push(`aresample=${MASTERING_POLICY.sampleRate}`);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', inputFormat, '-i', inputPath,
    '-af', filters.join(','),
    '-ac', String(MASTERING_POLICY.channels),
    '-ar', String(MASTERING_POLICY.sampleRate)
  ];
  if (masteredFormat === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', getMasteringBitrate());
  }
  args.push(outputPath);
  return args;
}

function assessAcousticQuality(measurement, policy = MASTERING_POLICY) {
  const issues = [];
  const integratedLufs = Number(measurement?.integratedLufs);
  const truePeakDb = Number(measurement?.truePeakDb);
  const loudnessRange = Number(measurement?.loudnessRange);
  const durationSeconds = Number(measurement?.durationSeconds);
  const minimumDurationSeconds = Number(measurement?.minimumDurationSeconds || 0);

  if (!Number.isFinite(integratedLufs)) issues.push('integrated loudness could not be measured');
  else if (Math.abs(integratedLufs - policy.integratedLufs) > policy.loudnessTolerance) {
    issues.push(`integrated loudness ${integratedLufs.toFixed(1)} LUFS is outside ${policy.integratedLufs} ± ${policy.loudnessTolerance} LU`);
  }
  if (!Number.isFinite(truePeakDb)) issues.push('true peak could not be measured');
  else if (truePeakDb > policy.maximumTruePeakDb) {
    issues.push(`true peak ${truePeakDb.toFixed(1)} dBTP exceeds ${policy.maximumTruePeakDb} dBTP`);
  }
  if (!Number.isFinite(loudnessRange)) issues.push('loudness range could not be measured');
  else if (loudnessRange > policy.maximumLoudnessRange) {
    issues.push(`loudness range ${loudnessRange.toFixed(1)} LU exceeds ${policy.maximumLoudnessRange} LU`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) issues.push('duration could not be measured');
  else if (minimumDurationSeconds > 0 && durationSeconds < minimumDurationSeconds) {
    issues.push(`duration ${durationSeconds.toFixed(2)}s is below ${minimumDurationSeconds.toFixed(2)}s`);
  }
  return { pass: issues.length === 0, issues, measurement };
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${command} failed: ${String(stderr || err.message).trim()}`));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function measureAcousticQuality(filePath, { minimumDurationSeconds = 0 } = {}) {
  const [durationResult, loudnessResult] = await Promise.all([
    execFileText('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]),
    execFileText('ffmpeg', [
      '-hide_banner', '-nostats', '-i', filePath,
      '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-'
    ])
  ]);
  const jsonMatch = loudnessResult.stderr.match(/\{[\s\S]*?"target_offset"\s*:\s*"[^"]+"[\s\S]*?\}/);
  if (!jsonMatch) throw new Error('ffmpeg did not return loudness measurements');
  const loudness = JSON.parse(jsonMatch[0]);
  return {
    durationSeconds: Number(durationResult.stdout.trim()),
    minimumDurationSeconds,
    integratedLufs: Number(loudness.input_i),
    truePeakDb: Number(loudness.input_tp),
    loudnessRange: Number(loudness.input_lra)
  };
}

async function verifyAudioFile(filePath, options = {}) {
  return assessAcousticQuality(await measureAcousticQuality(filePath, options), options.policy || MASTERING_POLICY);
}

module.exports = {
  MASTERING_POLICY,
  DEFAULT_ENGINE_GAIN_DB,
  masteringGainForEngine,
  getMasteringBitrate,
  masteringOutputFormat,
  buildMasteringArgs,
  assessAcousticQuality,
  measureAcousticQuality,
  verifyAudioFile
};
