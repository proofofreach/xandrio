const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dedupe } = require('../scripts/dedupe-narration-artifacts');

let passed = 0;
let failed = 0;

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function fixture() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-dedupe-'));
  const chapterDir = path.join(cacheDir, 'book_narration_artifacts_v1', 'ch2');
  fs.mkdirSync(chapterDir, { recursive: true });
  const add = (index, fingerprint, bytes, artifactBytes = bytes) => {
    const outputPath = path.join(cacheDir, `book_tts0123456789_ch2_chunk${index}.mp3`);
    fs.writeFileSync(outputPath, bytes);
    fs.writeFileSync(`${outputPath}.narration-artifact.json`, JSON.stringify({ fingerprint }));
    const artifactPath = path.join(chapterDir, `${fingerprint}.mp3`);
    fs.writeFileSync(artifactPath, artifactBytes);
    return { outputPath, artifactPath };
  };
  return { cacheDir, add };
}

const quiet = () => {};

(async () => {
  await test('dry run reports identical copies without changing them', async () => {
    const { cacheDir, add } = fixture();
    try {
      const { outputPath, artifactPath } = add(0, 'a'.repeat(64), Buffer.alloc(4096, 1));
      const summary = await dedupe({ cacheDir, log: quiet });
      assert.equal(summary.linked, 1);
      assert.equal(summary.bytes, 4096);
      assert.notEqual(fs.statSync(outputPath).ino, fs.statSync(artifactPath).ino);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  await test('apply links identical copies and leaves different bytes alone', async () => {
    const { cacheDir, add } = fixture();
    try {
      const same = add(0, 'a'.repeat(64), Buffer.alloc(4096, 1));
      const different = add(1, 'b'.repeat(64), Buffer.alloc(4096, 1), Buffer.alloc(4096, 2));
      const orphan = path.join(cacheDir, 'book_narration_artifacts_v1', 'ch2', `${'c'.repeat(64)}.mp3`);
      fs.writeFileSync(orphan, Buffer.alloc(10, 3));
      const summary = await dedupe({ cacheDir, apply: true, log: quiet });
      assert.deepEqual(
        { linked: summary.linked, mismatched: summary.mismatched, unmatched: summary.unmatched },
        { linked: 1, mismatched: 1, unmatched: 1 }
      );
      assert.equal(fs.statSync(same.outputPath).ino, fs.statSync(same.artifactPath).ino);
      assert.notEqual(fs.statSync(different.outputPath).ino, fs.statSync(different.artifactPath).ino);
      assert.deepEqual(fs.readFileSync(different.artifactPath), Buffer.alloc(4096, 2));
      assert.ok(fs.existsSync(orphan));
      assert.deepEqual(fs.readdirSync(path.dirname(orphan)).filter(name => name.endsWith('.tmp')), []);

      const again = await dedupe({ cacheDir, apply: true, log: quiet });
      assert.equal(again.linked, 0);
      assert.equal(again.alreadyShared, 1);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
