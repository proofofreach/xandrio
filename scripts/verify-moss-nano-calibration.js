// Master the real first-take calibration WAVs through the serving pipeline.
// Keep a repeatable acoustic receipt; do not silently adjust the fixed gains.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildMasteringArgs, verifyAudioFile } = require('../lib/audio-quality');
const { masteringGain } = require('../lib/moss-nano-tuning');
const calibration = require('../moss-nano/calibration.json');

(async () => {
  const directory = path.resolve(process.argv[2] || 'output/moss-nano/calibration');
  const results = [];
  for (const voice of Object.keys(calibration.voices)) {
    const inputPath = path.join(directory, `${voice}.wav`);
    const outputPath = path.join(directory, `${voice}.mp3`);
    execFileSync('ffmpeg', buildMasteringArgs({ inputPath, outputPath,
      gainDb: masteringGain(`moss-nano:${voice}`), downmixBeforeLimiting: true }));
    results.push({ voice, ...await verifyAudioFile(outputPath) });
  }
  await fs.writeFile(path.join(directory, 'mastered-report.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`${results.filter(result => result.pass).length}/${results.length} voices pass acoustic checks`);
  if (results.some(result => !result.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
