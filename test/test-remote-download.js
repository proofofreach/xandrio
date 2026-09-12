const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const crypto = require('crypto');
const { streamResponseToFile } = require('../lib/remote-download');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function responseFor(chunks, contentLength = null) {
  const headers = {
    get(name) {
      return name.toLowerCase() === 'content-length' ? contentLength : null;
    }
  };
  return { headers, body: Readable.toWeb(Readable.from(chunks)) };
}

async function residualParts(directory) {
  return (await fs.readdir(directory)).filter(name => name.endsWith('.part'));
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-download-'));
  try {
    await test('publishes a complete response', async () => {
      const destination = path.join(directory, 'book.epub');
      const returned = await streamResponseToFile(responseFor([Buffer.from('complete')]), destination, 32);
      assert.strictEqual(returned, destination);
      assert.deepStrictEqual(await fs.readFile(destination), Buffer.from('complete'));
      assert.deepStrictEqual(await residualParts(directory), []);
    });

    await test('rejects a declared oversize response without changing the destination', async () => {
      const destination = path.join(directory, 'declared.epub');
      await fs.writeFile(destination, 'previous');
      await assert.rejects(
        streamResponseToFile(responseFor([Buffer.from('small')], '12'), destination, 8),
        /exceeds the allowed size/
      );
      assert.strictEqual(await fs.readFile(destination, 'utf8'), 'previous');
      assert.deepStrictEqual(await residualParts(directory), []);
    });

    await test('rejects a streamed oversize response without changing the destination', async () => {
      const destination = path.join(directory, 'streamed.epub');
      await fs.writeFile(destination, 'previous');
      await assert.rejects(
        streamResponseToFile(responseFor([Buffer.from('four'), Buffer.from('more')]), destination, 7),
        /exceeds the allowed size/
      );
      assert.strictEqual(await fs.readFile(destination, 'utf8'), 'previous');
      assert.deepStrictEqual(await residualParts(directory), []);
    });

    await test('an exclusive-open collision preserves the unowned temporary file', async () => {
      const destination = path.join(directory, 'collision.epub');
      const suffix = Buffer.alloc(8).toString('hex');
      const existingPart = path.join(directory, `.collision.epub.${process.pid}.${suffix}.part`);
      await fs.writeFile(existingPart, 'another writer');
      const originalRandomBytes = crypto.randomBytes;
      crypto.randomBytes = size => Buffer.alloc(size);
      try {
        await assert.rejects(
          streamResponseToFile(responseFor([Buffer.from('new')]), destination, 32),
          error => error.code === 'EEXIST'
        );
        assert.strictEqual(await fs.readFile(existingPart, 'utf8'), 'another writer');
      } finally {
        crypto.randomBytes = originalRandomBytes;
        await fs.unlink(existingPart);
      }
    });

    await test('stream setup failure removes its owned temporary file', async () => {
      const destination = path.join(directory, 'invalid-body.epub');
      await fs.writeFile(destination, 'previous');
      await assert.rejects(
        streamResponseToFile({ headers: new Headers(), body: null }, destination, 32),
        TypeError
      );
      assert.strictEqual(await fs.readFile(destination, 'utf8'), 'previous');
      assert.deepStrictEqual(await residualParts(directory), []);
    });

    await test('concurrent writers never expose a partial same-destination file', async () => {
      const destination = path.join(directory, 'shared.epub');
      const first = Buffer.from('a'.repeat(32 * 1024));
      const second = Buffer.from('b'.repeat(32 * 1024));
      await Promise.all([
        streamResponseToFile(responseFor([first]), destination, first.length),
        streamResponseToFile(responseFor([second]), destination, second.length)
      ]);
      const written = await fs.readFile(destination);
      assert(written.equals(first) || written.equals(second), 'final destination must contain one complete writer');
      assert.deepStrictEqual(await residualParts(directory), []);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
