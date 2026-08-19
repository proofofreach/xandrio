'use strict';

/**
 * EPUB decompression-bomb limits.
 *
 * An EPUB is a ZIP, and nothing in the `epub` package or JSZip bounds the
 * *uncompressed* size of an entry. Deflate reaches roughly 1000:1 on repetitive
 * filler, so a few hundred KB of upload used to become hundreds of megabytes of
 * resident memory the moment the OPF was read. The central directory declares
 * those sizes, so the archive can be judged before anything is inflated.
 *
 * Run: node test/test-epub-zip-limits.js
 */

const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { parseEpub, MAX_EPUB_ENTRY_BYTES, __test } = require('../lib/epub-parser');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}`); console.error(`    ${error.stack || error.message}`); }
}

async function writeZip(directory, name, build) {
  const zip = new JSZip();
  build(zip);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filePath = path.join(directory, name);
  await fsp.writeFile(filePath, buffer);
  return { filePath, compressedBytes: buffer.length };
}

(async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-epub-limits-'));
  try {
    await test('an oversized entry is refused without inflating it', async () => {
      const oversized = MAX_EPUB_ENTRY_BYTES + 16 * 1024 * 1024;
      const { filePath, compressedBytes } = await writeZip(directory, 'bomb.epub', zip => {
        zip.file('mimetype', 'application/epub+zip');
        zip.file('content.opf', Buffer.alloc(oversized, 0x41));
      });
      // The point of the attack: the file on disk is trivially small.
      assert(compressedBytes < 5 * 1024 * 1024, 'the bomb is small on disk');

      const declared = await __test.declaredUncompressedSize(filePath);
      assert(declared.largest >= oversized, 'the declared size is read from the central directory');

      await assert.rejects(parseEpub(filePath), error => error.code === 'EPUB_UNCOMPRESSED_TOO_LARGE');
    });

    await test('an ordinary archive is measured and allowed through', async () => {
      const { filePath } = await writeZip(directory, 'small.epub', zip => {
        zip.file('mimetype', 'application/epub+zip');
        zip.file('content.opf', '<package/>');
      });
      const declared = await __test.declaredUncompressedSize(filePath);
      assert(declared.entryCount === 2, 'both entries are counted');
      assert(declared.total < 1024, 'a real package declares a small total');
      // The size gate must not object; parsing then fails for its own reasons
      // (this fixture is not a valid EPUB), which is not what is under test.
      await assert.doesNotReject(__test.assertEpubWithinLimits(filePath));
    });

    await test('an unreadable or non-ZIP file is not judged, and never throws', async () => {
      const notZip = path.join(directory, 'not-a-zip.epub');
      await fsp.writeFile(notZip, Buffer.alloc(4096, 0x00));
      assert.strictEqual(await __test.declaredUncompressedSize(notZip), null);
      await assert.doesNotReject(__test.assertEpubWithinLimits(notZip));
      assert.strictEqual(await __test.declaredUncompressedSize(path.join(directory, 'missing.epub')), null);
      await assert.doesNotReject(__test.assertEpubWithinLimits(path.join(directory, 'missing.epub')));
    });
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }

  await test('NCX title recovery stays linear on hostile input', async () => {
    // The previous regex rescanned to end-of-input from every <navLabel that
    // had no <text> after it. Measured at 4 MB it blocked the event loop for
    // ~33 seconds -- from an EPUB entry that compresses to almost nothing.
    const hostile = '<navLabel></navLabel>'.repeat(200_000);
    assert(hostile.length > 4_000_000, 'the fixture is the size that used to stall');
    const started = process.hrtime.bigint();
    const recovered = __test.ncxNavLabelTitles(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepStrictEqual(recovered, [], 'empty labels yield no titles');
    assert(elapsedMs < 2000, `scan took ${elapsedMs.toFixed(0)}ms, expected well under 2s`);
  });

  await test('NCX title recovery still reads a real navigation document', () => {
    const ncx = [
      '<navPoint><navLabel><text>Chapter One</text></navLabel><content src="c1.xhtml"/></navPoint>',
      '<navPoint><navLabel><text>Chapter Two</text></navLabel><content src="c2.xhtml"/></navPoint>'
    ].join('');
    assert.deepStrictEqual(__test.ncxNavLabelTitles(ncx), ['Chapter One', 'Chapter Two']);
  });

  await test('a navLabel with no text does not borrow the next one\'s title', () => {
    const ncx = '<navLabel></navLabel><navLabel><text>Real Title</text></navLabel>';
    assert.deepStrictEqual(__test.ncxNavLabelTitles(ncx), ['Real Title']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
