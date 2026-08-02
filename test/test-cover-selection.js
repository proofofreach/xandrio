const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ensureBookCover, validatedLibraryCoverInfo } = require('../server').__test;
const { inspectCoverVisualQuality } = require('../lib/cover-visual-quality');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-cover-selection-'));
  try {
    const weakBindingPath = path.join(tempRoot, 'weak-binding.jpg');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0xa71912:s=480x750:d=1',
      '-frames:v', '1', weakBindingPath
    ]);
    assert(validatedLibraryCoverInfo(fs.readFileSync(weakBindingPath)),
      'fixture must pass the structural cover validator');
    const weakVisualQuality = await inspectCoverVisualQuality(weakBindingPath);
    assert.equal(weakVisualQuality.status, 'measured');
    assert.equal(weakVisualQuality.lowInformation, true,
      'near-monochrome binding fixture must be classified as low-information');

    const meaningfulPath = path.join(tempRoot, 'meaningful-cover.jpg');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i',
      'color=c=0x3b185f:s=480x750:d=1,drawbox=x=50:y=100:w=380:h=90:color=white:t=fill,drawbox=x=50:y=230:w=300:h=50:color=yellow:t=fill,drawbox=x=50:y=600:w=220:h=30:color=white:t=fill',
      '-frames:v', '1', meaningfulPath
    ]);
    const meaningfulVisualQuality = await inspectCoverVisualQuality(meaningfulPath);
    assert.equal(meaningfulVisualQuality.status, 'measured');
    assert.equal(meaningfulVisualQuality.lowInformation, false,
      'a high-contrast designed cover fixture must remain eligible');

    const outputPath = path.join(tempRoot, 'selected-cover.jpg');
    const book = { id: 'semantic-cover', title: 'Semantic Cover', author: 'Author' };
    await ensureBookCover(book, {
      coverPath: outputPath,
      steps: [
        {
          id: 'embedded',
          label: 'embedded binding scan',
          fetch: async candidatePath => {
            fs.copyFileSync(weakBindingPath, candidatePath);
            return true;
          }
        },
        {
          id: 'catalog',
          label: 'catalog cover',
          fetch: async candidatePath => {
            fs.copyFileSync(meaningfulPath, candidatePath);
            return true;
          }
        }
      ]
    });

    assert.equal(book.coverSource, 'catalog',
      'a display-sized near-monochrome binding scan must not outrank a meaningful fallback');

    const fallbackPath = path.join(tempRoot, 'fallback-cover.jpg');
    const fallbackBook = { id: 'fallback-cover', title: 'Fallback Cover', author: 'Author' };
    await ensureBookCover(fallbackBook, {
      coverPath: fallbackPath,
      steps: [{
        id: 'embedded',
        label: 'only embedded binding scan',
        fetch: async candidatePath => {
          fs.copyFileSync(weakBindingPath, candidatePath);
          return true;
        }
      }]
    });
    assert.equal(fallbackBook.coverSource, 'embedded',
      'a weak cover remains available when no meaningful alternative exists');

    const unavailableProbe = await inspectCoverVisualQuality('/missing-cover.jpg', {
      execFileImpl: async () => { throw new Error('ffmpeg unavailable'); }
    });
    assert.deepEqual(unavailableProbe, { status: 'unknown', lowInformation: false },
      'visual probing fails open so cover delivery cannot depend on the classifier');
    console.log('✓ weak binding scans fall through to a meaningful cover candidate');
    console.log('1 passed, 0 failed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`✗ ${error.message}`);
  console.log('0 passed, 1 failed');
  process.exitCode = 1;
});
