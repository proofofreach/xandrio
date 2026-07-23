const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  createSearchCoverService,
  isSafeRemoteCoverUrl,
  normalizeIsbns
} = require('../lib/search-cover-service');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.stack || err.message}`);
  }
}

function jpegFixture() {
  const buffer = Buffer.alloc(2200, 7);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  return buffer;
}

function responseFor(buffer, url = 'https://covers.example/book.jpg') {
  return {
    ok: true,
    url,
    headers: { get: name => name.toLowerCase() === 'content-length' ? String(buffer.length) : null },
    arrayBuffer: async () => buffer
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    redirected: false,
    headers: { get: name => name.toLowerCase() === 'location' ? location : null }
  };
}

async function withService(overrides, fn) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-covers-'));
  const service = createSearchCoverService({
    cacheDir,
    getDimensions: () => ({ width: 320, height: 480 }),
    fetchCoverByISBN: async () => false,
    fetchCoverByOpenLibraryWorkKey: async () => false,
    fetchCoverFromGutenbergId: async () => false,
    fetchCoverFromAnnasPage: async () => false,
    fetchCoverFromGoogleBooks: async () => false,
    resolveOpenLibraryIdentity: async () => ({ confidence: { level: 'low' } }),
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    ...overrides
  });
  try {
    await fn(service, cacheDir);
  } finally {
    await service.flush();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

(async () => {
  await test('rejects local and private remote cover URLs', async () => {
    assert.strictEqual(isSafeRemoteCoverUrl('http://covers.example/book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://127.0.0.1/book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://192.168.1.2/book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://localhost./book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://covers.local./book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://[::1]/book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://[fc00::1]/book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://[::ffff:127.0.0.1]/book.jpg'), false);
    assert.strictEqual(isSafeRemoteCoverUrl('https://covers.example/book.jpg'), true);
  });

  await test('normalizes and deduplicates ISBN identities', async () => {
    assert.deepStrictEqual(normalizeIsbns(['978-1-234-56789-7', '9781234567897', 'bad']), ['9781234567897']);
  });

  await test('does not fetch a cover hostname that resolves to a private address', async () => {
    let fetches = 0;
    await withService({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: async () => {
        fetches += 1;
        return responseFor(jpegFixture());
      }
    }, async service => {
      const registered = service.register({
        source: 'standardebooks', hash: 'private-dns', title: 'Private DNS',
        coverUrl: 'https://covers.example/private.jpg'
      });
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.strictEqual(fetches, 0);
    });
  });

  await test('validates each manual redirect before fetching the next cover URL', async () => {
    const requests = [];
    await withService({
      lookupImpl: async hostname => hostname === 'redirector.example'
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '192.168.1.10', family: 4 }],
      fetchImpl: async (url, options) => {
        requests.push([String(url), options.redirect]);
        return redirectResponse('https://private-target.example/cover.jpg');
      }
    }, async service => {
      const registered = service.register({
        source: 'standardebooks', hash: 'private-redirect', title: 'Private Redirect',
        coverUrl: 'https://redirector.example/cover.jpg'
      });
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.deepStrictEqual(requests, [['https://redirector.example/cover.jpg', 'manual']]);
    });
  });

  await test('proxies a curated provider cover and reuses its disk cache', async () => {
    let fetchCount = 0;
    await withService({
      fetchImpl: async () => {
        fetchCount += 1;
        return responseFor(jpegFixture());
      }
    }, async service => {
      const registered = service.register({
        source: 'standardebooks', hash: 'edition-1', title: 'Correct Book', author: 'Correct Author',
        coverUrl: 'https://covers.example/book.jpg'
      });
      assert.match(registered.url, /^\/api\/search-cover\/[a-f0-9]{32}$/);
      const [first, concurrent] = await Promise.all([
        service.resolve(registered.key),
        service.resolve(registered.key)
      ]);
      assert.strictEqual(first.contentType, 'image/jpeg');
      assert.strictEqual(concurrent.contentType, 'image/jpeg');
      assert.strictEqual(fetchCount, 1);
      await service.resolve(registered.key);
      assert.strictEqual(fetchCount, 1);
    });
  });

  await test('promotes an already-resolved search cover into the library cache', async () => {
    let fetchCount = 0;
    await withService({
      fetchImpl: async () => {
        fetchCount += 1;
        return responseFor(jpegFixture());
      }
    }, async (service, cacheDir) => {
      const registered = service.register({
        source: 'standardebooks', hash: 'selected-edition', title: 'Selected Book', author: 'Selected Author',
        coverUrl: 'https://covers.example/selected.jpg'
      });
      assert.ok(await service.resolve(registered.key));
      const libraryPath = path.join(cacheDir, 'library-cover.jpg');
      assert.strictEqual(await service.copyTo(registered.key, libraryPath), true);
      assert.deepStrictEqual(await fs.readFile(libraryPath), jpegFixture());
      assert.strictEqual(fetchCount, 1);
    });
  });

  await test('falls back to a high-confidence catalog identity after a broken provider image', async () => {
    let workFetches = 0;
    await withService({
      fetchImpl: async () => responseFor(Buffer.from('not an image')),
      resolveOpenLibraryIdentity: async () => ({
        confidence: { level: 'high' },
        openLibraryWorkKey: '/works/OL123W'
      }),
      fetchCoverByOpenLibraryWorkKey: async (_key, outputPath) => {
        workFetches += 1;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'edition-2', title: 'Matched Book', author: 'Matched Author',
        coverUrl: 'https://covers.example/broken.jpg'
      });
      const cover = await service.resolve(registered.key);
      assert.strictEqual(cover.contentType, 'image/jpeg');
      assert.strictEqual(workFetches, 1);
    });
  });

  await test('prefers a known catalog work over a scraped-source thumbnail', async () => {
    let remoteFetches = 0;
    let workFetches = 0;
    await withService({
      fetchImpl: async () => { remoteFetches += 1; return responseFor(jpegFixture()); },
      fetchCoverByOpenLibraryWorkKey: async (_key, outputPath) => {
        workFetches += 1;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'edition-catalog', title: 'Catalog Book', author: 'Author',
        openLibraryWorkKey: '/works/OLCATALOGW', coverUrl: 'https://covers.example/scan-page.jpg'
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(workFetches, 1);
      assert.strictEqual(remoteFetches, 0);
    });
  });

  await test('does not use low-confidence title-only catalog matches', async () => {
    let identityCalls = 0;
    await withService({
      resolveOpenLibraryIdentity: async () => {
        identityCalls += 1;
        return { confidence: { level: 'medium' }, openLibraryWorkKey: '/works/wrong' };
      }
    }, async service => {
      const registered = service.register({ source: 'annas', hash: 'edition-3', title: 'Ambiguous', author: 'Unknown' });
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.strictEqual(identityCalls, 1);
    });
  });

  await test('does not render a scraped thumbnail when catalog identity is ambiguous', async () => {
    let remoteFetches = 0;
    await withService({
      fetchImpl: async () => { remoteFetches += 1; return responseFor(jpegFixture()); }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'edition-scan', title: 'Ambiguous Translation', author: 'Known Author',
        coverUrl: 'https://covers.example/scanned-interior-page.jpg'
      });
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.strictEqual(remoteFetches, 0);
    });
  });

  await test('falls back to a validated Google Books cover after Open Library misses', async () => {
    let googleFetches = 0;
    await withService({
      fetchCoverFromGoogleBooks: async (_title, _author, outputPath) => {
        googleFetches += 1;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'edition-google', title: 'Book of Sketches', author: 'Jack Kerouac'
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(googleFetches, 1);
    });
  });

  await test('uses a catalog cover before an Anna edition-page fallback', async () => {
    let pageFetches = 0;
    let googleFetches = 0;
    await withService({
      fetchCoverFromAnnasPage: async (_pageUrl, outputPath) => {
        pageFetches += 1;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      },
      fetchCoverFromGoogleBooks: async (_title, _author, outputPath) => {
        googleFetches += 1;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'anna-generated-fallback', title: 'Catalogued Book', author: 'Known Author',
        url: 'https://annas.example/md5/0123456789abcdef0123456789abcdef'
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(googleFetches, 1);
      assert.strictEqual(pageFetches, 0);
    });
  });

  await test('recovers an Anna edition-page cover after catalog fallbacks miss', async () => {
    let pageFetches = 0;
    let googleFetches = 0;
    let identityCalls = 0;
    await withService({
      resolveOpenLibraryIdentity: async () => {
        identityCalls += 1;
        return { confidence: { level: 'low' } };
      },
      fetchCoverFromAnnasPage: async (pageUrl, outputPath) => {
        pageFetches += 1;
        assert.equal(pageUrl, 'https://annas.example/md5/0123456789abcdef0123456789abcdef');
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      },
      fetchCoverFromGoogleBooks: async () => {
        googleFetches += 1;
        return false;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'anna-page-cover', title: 'Edition-specific Book', author: 'Known Author',
        url: 'https://annas.example/md5/0123456789abcdef0123456789abcdef'
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(pageFetches, 1);
      assert.strictEqual(googleFetches, 1);
      assert.strictEqual(identityCalls, 1);
    });
  });

  await test('does not pass an unsafe Anna page URL to the page-cover fetcher', async () => {
    let pageFetches = 0;
    await withService({
      fetchCoverFromAnnasPage: async () => {
        pageFetches += 1;
        return false;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'unsafe-anna-page', title: 'Unsafe Page', author: 'Author',
        url: 'https://127.0.0.1/md5/0123456789abcdef0123456789abcdef'
      });
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.strictEqual(pageFetches, 0);
    });
  });

  await test('coalesces equivalent work cover requests across provider editions', async () => {
    let workFetches = 0;
    await withService({
      fetchCoverByOpenLibraryWorkKey: async (_key, outputPath) => {
        workFetches += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const anna = service.register({
        source: 'annas', hash: 'anna-edition', title: 'Shared Work', author: 'Known Author',
        openLibraryWorkKey: '/works/OLSHAREDW'
      });
      const zlib = service.register({
        source: 'zlibrary', hash: 'zlib-edition', title: 'Shared Work', author: 'Known Author',
        openLibraryWorkKey: '/works/OLSHAREDW'
      });
      const covers = await Promise.all([service.resolve(anna.key), service.resolve(zlib.key)]);
      assert.ok(covers.every(Boolean));
      assert.strictEqual(workFetches, 1);
    });
  });

  await test('loads a persisted descriptor after a service restart', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-cover-restart-'));
    const options = {
      cacheDir,
      getDimensions: () => ({ width: 320, height: 480 }),
      fetchCoverByISBN: async () => false,
      fetchCoverByOpenLibraryWorkKey: async (_key, outputPath) => {
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      },
      fetchCoverFromGutenbergId: async () => false,
      fetchCoverFromAnnasPage: async () => false,
      fetchCoverFromGoogleBooks: async () => false,
      resolveOpenLibraryIdentity: async () => ({ confidence: { level: 'low' } }),
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }]
    };
    try {
      const first = createSearchCoverService(options);
      const registered = first.register({
        source: 'annas', hash: 'restart-edition', title: 'Restart-safe Book', author: 'Known Author',
        openLibraryWorkKey: '/works/OLRESTARTW'
      });
      await first.flush();
      const restarted = createSearchCoverService(options);
      assert.ok(await restarted.resolve(registered.key));
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('persists an uncached provider URL descriptor across a restart', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-cover-url-restart-'));
    const options = {
      cacheDir,
      getDimensions: () => ({ width: 320, height: 480 }),
      fetchImpl: async () => responseFor(jpegFixture()),
      fetchCoverByISBN: async () => false,
      fetchCoverByOpenLibraryWorkKey: async () => false,
      fetchCoverFromGutenbergId: async () => false,
      fetchCoverFromAnnasPage: async () => false,
      fetchCoverFromGoogleBooks: async () => false,
      resolveOpenLibraryIdentity: async () => ({ confidence: { level: 'low' } }),
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }]
    };
    try {
      const first = createSearchCoverService(options);
      const registered = first.register({
        source: 'standardebooks', hash: 'restart-url', title: 'Restart URL', author: 'Author',
        coverUrl: 'https://covers.example/restart.jpg'
      });
      await first.flush();
      const restarted = createSearchCoverService(options);
      assert.ok(await restarted.resolve(registered.key));
      await restarted.flush();
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('rejects a tampered persisted descriptor before it can fetch a page URL', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-cover-tampered-'));
    let pageFetches = 0;
    const options = {
      cacheDir,
      getDimensions: () => ({ width: 320, height: 480 }),
      fetchCoverFromAnnasPage: async () => {
        pageFetches += 1;
        return false;
      },
      fetchCoverByISBN: async () => false,
      fetchCoverByOpenLibraryWorkKey: async () => false,
      fetchCoverFromGutenbergId: async () => false,
      fetchCoverFromGoogleBooks: async () => false,
      resolveOpenLibraryIdentity: async () => ({ confidence: { level: 'low' } }),
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }]
    };
    try {
      const first = createSearchCoverService(options);
      const registered = first.register({
        source: 'annas', hash: 'tampered-registry', title: 'Tampered Registry', author: 'Author'
      });
      await first.flush();
      const registryPath = path.join(cacheDir, 'descriptors.json');
      const persisted = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      persisted.entries[0].descriptor.sourcePageUrl = 'https://127.0.0.1/md5/0123456789abcdef0123456789abcdef';
      await fs.writeFile(registryPath, JSON.stringify(persisted));

      const restarted = createSearchCoverService(options);
      assert.strictEqual(await restarted.resolve(registered.key), null);
      assert.strictEqual(pageFetches, 0);
      await restarted.flush();
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('recovers descriptor persistence after an atomic write failure', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-cover-persist-failure-'));
    const registryPath = path.join(cacheDir, 'descriptors.json');
    await fs.mkdir(registryPath);
    const service = createSearchCoverService({ cacheDir });
    try {
      service.register({ source: 'annas', hash: 'persistence-failure-1', title: 'First' });
      await assert.rejects(service.flush(), /Unable to persist search-cover descriptor registry/);

      await fs.rm(registryPath, { recursive: true, force: true });
      service.register({ source: 'annas', hash: 'persistence-failure-2', title: 'Second' });
      await service.flush();
      const persisted = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      assert.strictEqual(persisted.entries.length, 2);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('coalesces burst descriptor registrations into one registry write', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-search-cover-persist-burst-'));
    const registryPrefix = `${path.join(cacheDir, 'descriptors.json')}.`;
    const originalWriteFile = fs.writeFile;
    let registryWrites = 0;
    fs.writeFile = async (filePath, ...args) => {
      if (String(filePath).startsWith(registryPrefix) && String(filePath).endsWith('.part')) registryWrites += 1;
      return originalWriteFile(filePath, ...args);
    };
    try {
      const service = createSearchCoverService({ cacheDir });
      for (let index = 0; index < 50; index += 1) {
        service.register({ source: 'annas', hash: `burst-${index}`, title: `Burst ${index}` });
      }
      await service.flush();
      assert.strictEqual(registryWrites, 1);
    } finally {
      fs.writeFile = originalWriteFile;
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('explicit retry bypasses a transient negative cover cache', async () => {
    let available = false;
    await withService({
      fetchCoverFromGoogleBooks: async (_title, _author, outputPath) => {
        if (!available) return false;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const registered = service.register({ source: 'annas', hash: 'retry-cover', title: 'Retry Book', author: 'Author' });
      assert.strictEqual(await service.resolve(registered.key), null);
      available = true;
      assert.strictEqual(await service.resolve(registered.key), null);
      assert.ok(await service.resolve(registered.key, { retry: true }));
    });
  });

  await test('falls back to a validated Z-Library cover after catalog lookups miss', async () => {
    let remoteFetches = 0;
    await withService({
      fetchImpl: async url => {
        remoteFetches += 1;
        assert.equal(String(url), 'https://covers.z-library.test/covered.jpg');
        return responseFor(jpegFixture(), String(url));
      }
    }, async service => {
      const registered = service.register({
        source: 'zlibrary', hash: 'zlib-covered', title: 'Covered Book', author: 'Known Author',
        coverUrl: 'https://covers.z-library.test/covered.jpg'
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(remoteFetches, 1);
    });
  });

  await test('uses a high-confidence Open Library search cover id directly', async () => {
    let remoteFetches = 0;
    await withService({
      fetchImpl: async url => {
        remoteFetches += 1;
        assert.match(String(url), /covers\.openlibrary\.org\/b\/id\/109465-L\.jpg/);
        return responseFor(jpegFixture(), String(url));
      },
      resolveOpenLibraryIdentity: async () => ({
        confidence: { level: 'high' },
        openLibraryWorkKey: '/works/OLSKETCHESW',
        coverId: 109465
      })
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'edition-cover-id', title: 'Book of Sketches', author: 'Jack Kerouac'
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(remoteFetches, 1);
    });
  });

  await test('uses an ISBN without fetching an unsafe supplied URL', async () => {
    let remoteFetches = 0;
    let isbnFetches = 0;
    await withService({
      fetchImpl: async () => { remoteFetches += 1; return responseFor(jpegFixture()); },
      fetchCoverByISBN: async (_isbn, outputPath) => {
        isbnFetches += 1;
        await fs.writeFile(outputPath, jpegFixture());
        return true;
      }
    }, async service => {
      const registered = service.register({
        source: 'annas', hash: 'edition-4', title: 'ISBN Book', author: 'Author',
        coverUrl: 'https://127.0.0.1/private.jpg', isbn: ['978-1-234-56789-7']
      });
      assert.ok(await service.resolve(registered.key));
      assert.strictEqual(remoteFetches, 0);
      assert.strictEqual(isbnFetches, 1);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
