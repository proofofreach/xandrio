const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  fetchCoverByISBN,
  fetchCoverFromAnnasPage,
  fetchCoverFromGoogleBooks,
  fetchCoverFromOpenLibrary,
  fetchCoverByOpenLibraryWorkKey,
  fetchCoverFromGutenbergId
} = require('../lib/cover-service');

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

function coverFixture() {
  const image = Buffer.alloc(1400, 8);
  image[0] = 0xff;
  image[1] = 0xd8;
  image[2] = 0xff;
  image[3] = 0xe0;
  image.writeUInt16BE(16, 4);
  image[20] = 0xff;
  image[21] = 0xc0;
  image.writeUInt16BE(17, 22);
  image[24] = 8;
  image.writeUInt16BE(400, 25);
  image.writeUInt16BE(320, 27);
  image[29] = 3;
  image[image.length - 2] = 0xff;
  image[image.length - 1] = 0xd9;
  return image;
}

function truncatedPngFixture() {
  const image = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
  image.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(image, 12);
  image.writeUInt32BE(320, 16);
  image.writeUInt32BE(400, 20);
  image[24] = 8;
  image[25] = 2;
  return image;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-cover-security-'));
  try {
    await test('rejects an ISBN cover hostname that resolves to a private address', async () => {
      let fetches = 0;
      const result = await fetchCoverByISBN('9781234567897', path.join(tempDir, 'private.jpg'), {
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        fetchImpl: async () => { fetches += 1; return new Response(coverFixture()); }
      });
      assert.strictEqual(result, false);
      assert.strictEqual(fetches, 0);
    });

    await test('validates a redirected cover and keeps the response bounded', async () => {
      const requests = [];
      const result = await fetchCoverByISBN('9781234567897', path.join(tempDir, 'redirect.jpg'), {
        lookupImpl: async hostname => hostname === 'covers.openlibrary.org'
          ? [{ address: '8.8.8.8', family: 4 }]
          : [{ address: '1.1.1.1', family: 4 }],
        fetchImpl: async (url, options) => {
          requests.push([String(url), options.redirect]);
          if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/cover.jpg' } });
          return new Response(coverFixture(), { headers: { 'content-length': String(coverFixture().length) } });
        }
      });
      assert.strictEqual(result, true);
      assert.deepStrictEqual(requests, [
        ['https://covers.openlibrary.org/b/isbn/9781234567897-L.jpg?default=false', 'manual'],
        ['https://cdn.example/cover.jpg', 'manual']
      ]);
    });

    await test('extracts an edition cover from an allowed Anna detail page', async () => {
      const requests = [];
      const pageUrl = 'https://annas.example/md5/0123456789abcdef0123456789abcdef';
      const imageUrl = 'https://covers.example/covers400/book.jpg';
      const result = await fetchCoverFromAnnasPage(pageUrl, path.join(tempDir, 'anna.jpg'), {
        expectedOrigin: 'https://annas.example',
        lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
        fetchImpl: async url => {
          requests.push(String(url));
          if (String(url) === pageUrl) {
            return new Response(`<html><img class="w-full object-cover" src="${imageUrl}" alt=""></html>`, {
              headers: { 'content-type': 'text/html' }
            });
          }
          return new Response(coverFixture(), { headers: { 'content-type': 'image/jpeg' } });
        }
      });
      assert.strictEqual(result, true);
      assert.deepStrictEqual(requests, [pageUrl, imageUrl]);
    });

    await test('refuses Anna pages outside the configured origin and private cover targets', async () => {
      let requests = 0;
      const outside = await fetchCoverFromAnnasPage(
        'https://attacker.example/md5/0123456789abcdef0123456789abcdef',
        path.join(tempDir, 'outside.jpg'),
        {
          expectedOrigin: 'https://annas.example',
          fetchImpl: async () => { requests += 1; return new Response(''); }
        }
      );
      assert.strictEqual(outside, false);
      assert.strictEqual(requests, 0);

      const privateCover = await fetchCoverFromAnnasPage(
        'https://annas.example/md5/0123456789abcdef0123456789abcdef',
        path.join(tempDir, 'private-cover.jpg'),
        {
          expectedOrigin: 'https://annas.example',
          lookupImpl: async hostname => hostname === 'annas.example'
            ? [{ address: '8.8.8.8', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }],
          fetchImpl: async url => {
            requests += 1;
            return new Response(`<img class="object-cover" src="https://private.example/cover.jpg">`);
          }
        }
      );
      assert.strictEqual(privateCover, false);
      assert.strictEqual(requests, 1);
    });

    await test('rejects non-exact Anna origins and edition paths before requesting them', async () => {
      let requests = 0;
      for (const [pageUrl, expectedOrigin] of [
        ['https://annas.example/md5/0123456789abcdef0123456789abcdef/', 'https://annas.example'],
        ['https://annas.example/md5/0123456789abcdef0123456789abcdef?cover=1', 'https://annas.example'],
        ['https://annas.example/md5/0123456789abcdef0123456789abcdef', 'https://annas.example/config']
      ]) {
        const result = await fetchCoverFromAnnasPage(pageUrl, path.join(tempDir, 'invalid-url.jpg'), {
          expectedOrigin,
          fetchImpl: async () => { requests += 1; return new Response(''); }
        });
        assert.strictEqual(result, false);
      }
      assert.strictEqual(requests, 0);
    });

    await test('rejects oversized, malformed, and non-image Anna cover responses', async () => {
      const pageUrl = 'https://annas.example/md5/0123456789abcdef0123456789abcdef';
      const imageUrl = 'https://covers.example/book';
      const invalidBodies = [
        new Response('not an image'),
        new Response(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00])),
        new Response(coverFixture().subarray(0, -2)),
        new Response(truncatedPngFixture()),
        new Response(null, { headers: { 'content-length': String(9 * 1024 * 1024) } })
      ];
      for (let index = 0; index < invalidBodies.length; index += 1) {
        const outputPath = path.join(tempDir, `invalid-cover-${index}.jpg`);
        const result = await fetchCoverFromAnnasPage(pageUrl, outputPath, {
          expectedOrigin: 'https://annas.example',
          lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
          fetchImpl: async url => String(url) === pageUrl
            ? new Response(`<img class="object-cover" src="${imageUrl}">`)
            : invalidBodies[index]
        });
        assert.strictEqual(result, false);
        await assert.rejects(fs.access(outputPath));
      }
    });

    await test('keeps Anna detail-page responses bounded before parsing cover markup', async () => {
      const result = await fetchCoverFromAnnasPage(
        'https://annas.example/md5/0123456789abcdef0123456789abcdef',
        path.join(tempDir, 'oversized-page.jpg'),
        {
          expectedOrigin: 'https://annas.example',
          lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
          fetchImpl: async () => new Response(null, { headers: { 'content-length': String(1024 * 1024) } })
        }
      );
      assert.strictEqual(result, false);
    });

    await test('does not follow an Anna detail-page redirect outside the configured origin', async () => {
      const requests = [];
      const result = await fetchCoverFromAnnasPage(
        'https://annas.example/md5/0123456789abcdef0123456789abcdef',
        path.join(tempDir, 'redirected-page.jpg'),
        {
          expectedOrigin: 'https://annas.example',
          lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
          fetchImpl: async url => {
            requests.push(String(url));
            return new Response(null, { status: 302, headers: { location: 'https://attacker.example/md5/0123456789abcdef0123456789abcdef' } });
          }
        }
      );
      assert.strictEqual(result, false);
      assert.deepStrictEqual(requests, ['https://annas.example/md5/0123456789abcdef0123456789abcdef']);
    });

    await test('rejects malformed 200 image bodies from every remote cover writer', async () => {
      const malformedImage = coverFixture().subarray(0, -2);
      const safeNetwork = { lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }] };
      const cases = [
        ['Google Books', outputPath => fetchCoverFromGoogleBooks('Example Book', 'Example Author', outputPath, {
          ...safeNetwork,
          fetchImpl: async url => new URL(String(url)).hostname === 'www.googleapis.com'
            ? jsonResponse({ items: [{ volumeInfo: {
              title: 'Example Book', authors: ['Example Author'], imageLinks: { thumbnail: 'https://images.example/cover' }
            } }] })
            : new Response(malformedImage)
        })],
        ['Open Library ISBN', outputPath => fetchCoverByISBN('9781234567897', outputPath, {
          ...safeNetwork, fetchImpl: async () => new Response(malformedImage)
        })],
        ['Open Library search', outputPath => fetchCoverFromOpenLibrary('Example Book', 'Example Author', outputPath, {
          ...safeNetwork,
          fetchImpl: async url => new URL(String(url)).hostname === 'openlibrary.org'
            ? jsonResponse({ docs: [{ title: 'Example Book', author_name: ['Example Author'], cover_i: 123 }] })
            : new Response(malformedImage)
        })],
        ['Open Library work', outputPath => fetchCoverByOpenLibraryWorkKey('OL123W', outputPath, {
          ...safeNetwork,
          fetchImpl: async url => new URL(String(url)).hostname === 'openlibrary.org'
            ? jsonResponse({ covers: [123] })
            : new Response(malformedImage)
        })],
        ['Project Gutenberg', outputPath => fetchCoverFromGutenbergId('123', outputPath, {
          ...safeNetwork, fetchImpl: async () => new Response(malformedImage)
        })]
      ];

      for (const [name, fetchCover] of cases) {
        const outputPath = path.join(tempDir, `${name.replace(/\s+/g, '-').toLowerCase()}.jpg`);
        assert.strictEqual(await fetchCover(outputPath), false, `${name} accepted malformed image bytes`);
        await assert.rejects(fs.access(outputPath));
      }
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
