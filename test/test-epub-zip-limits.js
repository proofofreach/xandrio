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

// A STORE-only ZIP writer, enough to express a ZIP64 extra field.
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);
    const extra = entry.zip64UncompressedSize === undefined ? Buffer.alloc(0) : Buffer.alloc(12);
    if (extra.length) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(entry.zip64UncompressedSize), 4);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(extra.length ? 0xffffffff : entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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

      const declared = __test.declaredUncompressedSize(await JSZip.loadAsync(await fsp.readFile(filePath)));
      assert(declared.largest >= oversized, 'the declared size is read from the central directory');

      await assert.rejects(parseEpub(filePath), error => error.code === 'EPUB_UNCOMPRESSED_TOO_LARGE');
    });

    await test('an ordinary archive is measured and allowed through', async () => {
      const { filePath } = await writeZip(directory, 'small.epub', zip => {
        zip.file('mimetype', 'application/epub+zip');
        zip.file('content.opf', '<package/>');
      });
      const zip = await __test.openBoundedZip(filePath);
      const declared = __test.declaredUncompressedSize(zip);
      assert(declared.entryCount === 2, 'both entries are counted');
      assert(declared.total < 1024, 'a real package declares a small total');
      assert.strictEqual(await zip.file('content.opf').async('string'), '<package/>',
        'an entry that inflates to its declared size reads normally');
    });

    await test('an unreadable or non-ZIP file is refused as an invalid archive', async () => {
      const notZip = path.join(directory, 'not-a-zip.epub');
      await fsp.writeFile(notZip, Buffer.alloc(4096, 0x00));
      await assert.rejects(parseEpub(notZip), /Invalid\/missing file/);
      await assert.rejects(parseEpub(path.join(directory, 'missing.epub')), /Invalid\/missing file/);
    });

    // The central directory is attacker-written. An entry that declares 100
    // bytes but deflates to 8 MB used to be inflated in full -- JSZip compares
    // the two only after accumulating the whole entry -- so the declared-size
    // gate bounded nothing.
    await test('an entry inflating past its declared size is stopped while inflating', async () => {
      const actual = 8 * 1024 * 1024;
      const declaredSize = 100;
      const zip = new JSZip();
      zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
      zip.file('content.opf', Buffer.alloc(actual, 0x41));
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      const name = Buffer.from('content.opf');
      let patched = 0;
      for (let offset = 0; offset + 4 <= buffer.length; offset += 1) {
        const signature = buffer.readUInt32LE(offset);
        if (signature === 0x04034b50 && buffer.subarray(offset + 30, offset + 30 + name.length).equals(name)) {
          buffer.writeUInt32LE(declaredSize, offset + 22);
          patched += 1;
        } else if (signature === 0x02014b50 && buffer.subarray(offset + 46, offset + 46 + name.length).equals(name)) {
          buffer.writeUInt32LE(declaredSize, offset + 24);
          patched += 1;
        }
      }
      assert.strictEqual(patched, 2, 'the local and central headers both lie');
      const filePath = path.join(directory, 'lying.epub');
      await fsp.writeFile(filePath, buffer);

      const bounded = await __test.openBoundedZip(filePath);
      await assert.rejects(bounded.file('content.opf').async('nodebuffer'),
        error => error.code === 'EPUB_UNCOMPRESSED_TOO_LARGE' && /declared 100 bytes/.test(error.message));
      await assert.rejects(new Promise((resolve, reject) => {
        bounded.file('content.opf').nodeStream().on('data', () => {}).on('end', resolve).on('error', reject);
      }), error => error.code === 'EPUB_UNCOMPRESSED_TOO_LARGE', 'streamed reads are bounded too');
    });

    // ZIP64 parks 0xffffffff in the 32-bit size field and the real size in an
    // extra field. The previous directory scan declined to judge any such
    // archive, so a ZIP64 marker waved a bomb through.
    await test('a ZIP64 entry is judged by its 64-bit declared size', async () => {
      const filePath = path.join(directory, 'zip64.epub');
      await fsp.writeFile(filePath, storedZip([
        { name: 'mimetype', data: Buffer.from('application/epub+zip') },
        { name: 'content.opf', data: Buffer.from('<package/>'), zip64UncompressedSize: MAX_EPUB_ENTRY_BYTES + 1 }
      ]));
      await assert.rejects(parseEpub(filePath), error => error.code === 'EPUB_UNCOMPRESSED_TOO_LARGE' &&
        new RegExp(`${MAX_EPUB_ENTRY_BYTES + 1}-byte entry`).test(error.message));
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
