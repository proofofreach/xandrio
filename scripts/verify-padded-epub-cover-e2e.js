// Failure modes: padded valid JPEG rejected; corrupt JPEG accepted; stored cover remains padded.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSyntheticImportEpub } = require('./lib/import-benchmark-fixtures');
const { extractCover } = require('../lib/cover-service');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'padded-cover-'));
  const results = [];
  try {
    const source = await createSyntheticImportEpub(root);
    const opf = path.join(root, 'epub-source/OEBPS/content.opf');
    await fs.writeFile(opf, (await fs.readFile(opf, 'utf8')).replace('</metadata>', '<meta name="cover" content="cover"/></metadata>').replace('<manifest>', '<manifest><item id="cover" href="cover.jpg" media-type="image/jpeg"/>'));
    const jpeg = await fs.readFile(path.join(__dirname, '../test/fixtures/scenarios/covers/cover-meridian.jpg'));
    for (const [name, bytes, expected] of [
      ['zero padding', Buffer.concat([jpeg, Buffer.alloc(2)]), true],
      ['truncated JPEG', jpeg.subarray(0, -2), false],
      ['non-padding trailer', Buffer.concat([jpeg, Buffer.from('invalid')]), false]
    ]) {
      await fs.writeFile(path.join(root, 'epub-source/OEBPS/cover.jpg'), bytes);
      execFileSync('zip', ['-qr9', source, 'OEBPS'], { cwd: path.join(root, 'epub-source') });
      const output = path.join(root, 'cover.jpg');
      assert.equal(await extractCover(source, output), expected, name);
      if (expected) assert.deepEqual(await fs.readFile(output), jpeg, 'canonical image excludes padding');
      results.push({ name, passed: true });
    }
    const out = path.join(__dirname, '../output/cover-recovery');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'padded-epub.json'), JSON.stringify({ passed: true, results }, null, 2));
    console.log('3 passed, 0 failed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
