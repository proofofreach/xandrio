/** Offline tests for the LibGen search parser and mirror-rotation contract. */
const assert = require('assert');
const { parseLibgenResults, searchLibgen, configuredMirrors, DEFAULT_MIRRORS } = require('../lib/libgen');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (error) { console.error(`  ❌ ${name}`); throw error; }
}

// One results row in the real libgen.li shape: a <b>series</b>, then a detail
// anchor whose tooltip title= contains a literal <br> (the case that defeats a
// naive "<a …>" scan), then an <nobr> badge cluster, and a Mirrors cell whose
// hrefs carry the md5. `md5` must be 32 hex chars; other fields are free text.
function row({ series = '', title, editionId = '1', author, publisher, year = '2020', language, pages = '300', size, ext, md5 }) {
  const seriesTag = series ? `<b>${series}</b><br>` : '';
  return `<tr>` +
    `<td>${seriesTag}<a data-toggle="tooltip" data-html="true" ` +
      `title="Add/Edit : 2026-01-11; ID: 999<br>${author} - ${title} (${year}, ${publisher})" ` +
      `href="edition.php?id=${editionId}">${title} <i></i></a> ` +
      `<nobr><span class="badge badge-primary"><a title="Book">b</a></span> ` +
      `<span class="badge badge-secondary">f 8160349</span></nobr></td>` +
    `<td>${author}</td>` +
    `<td>${publisher}</td>` +
    `<td>${year}</td>` +
    `<td>${language}</td>` +
    `<td>${pages}</td>` +
    `<td>${size}</td>` +
    `<td>${ext}</td>` +
    `<td><a title="libgen" href="/ads.php?md5=${md5}"><span class="badge">1</span></a> ` +
      `<a title="anna's archive" href="https://annas-archive.gl/md5/${md5}"><span class="badge">3</span></a></td>` +
    `</tr>`;
}

const HEADER_ROW = `<tr><th>ID</th><th>Author(s)</th><th>Publisher</th><th>Year</th>` +
  `<th>Language</th><th>Pages</th><th>Size</th><th>Ext.</th><th>Mirrors</th></tr>`;

function page(...rows) {
  return `<html><body><table>${HEADER_ROW}${rows.join('')}</table></body></html>`;
}

(async () => {
  console.log('\n━━━ LibGen search ━━━');

  await test('parses the standard nine-column row into the Anna result shape', async () => {
    const html = page(row({
      series: 'Dune 1', title: 'Dune - Frank Herbert', author: 'Herbert, Frank',
      publisher: 'Volt', language: 'Dutch', size: '2 MB', ext: 'epub',
      md5: '715668dff89c0a882d268772797f247d'
    }));
    const [book] = parseLibgenResults(html, { baseUrl: 'https://libgen.li' });
    // Title is the anchor text only -- no series prefix, no <nobr> badge leak.
    assert.equal(book.title, 'Dune - Frank Herbert');
    assert.equal(book.author, 'Herbert, Frank');
    assert.equal(book.publisher, 'Volt');
    assert.equal(book.language, 'Dutch');
    assert.equal(book.format, 'EPUB');
    assert.equal(book.size, '2 MB');
    assert.equal(book.hash, '715668dff89c0a882d268772797f247d');
    assert.equal(book.url, 'https://libgen.li/ads.php?md5=715668dff89c0a882d268772797f247d');
  });

  await test('lowercases the md5 and keeps it 32 hex chars', async () => {
    const html = page(row({
      title: 'Upper Hash', author: 'A', publisher: 'P', language: 'English',
      size: '1 MB', ext: 'epub', md5: 'ABCDEF0123456789ABCDEF0123456789'
    }));
    const [book] = parseLibgenResults(html);
    assert.equal(book.hash, 'abcdef0123456789abcdef0123456789');
  });

  await test('skips the header row and any row without an md5', async () => {
    const html = page(
      `<tr><td>not a book</td><td>x</td><td>y</td><td>z</td><td>en</td><td>1</td><td>1 MB</td><td>epub</td><td>no mirror</td></tr>`,
      row({ title: 'Real', author: 'A', publisher: 'P', language: 'English', size: '1 MB', ext: 'epub', md5: '11111111111111111111111111111111' })
    );
    const results = parseLibgenResults(html);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Real');
  });

  await test('drops files below the minimum book size', async () => {
    const html = page(
      row({ title: 'Tiny Stub', author: 'A', publisher: 'P', language: 'English', size: '12 KB', ext: 'epub', md5: '22222222222222222222222222222222' }),
      row({ title: 'Full Book', author: 'A', publisher: 'P', language: 'English', size: '2 MB', ext: 'epub', md5: '33333333333333333333333333333333' })
    );
    const titles = parseLibgenResults(html).map(b => b.title);
    assert.deepEqual(titles, ['Full Book']);
  });

  await test('drops formats the import pipeline cannot handle', async () => {
    const html = page(
      row({ title: 'Scanned', author: 'A', publisher: 'P', language: 'English', size: '5 MB', ext: 'djvu', md5: '44444444444444444444444444444444' }),
      row({ title: 'Ebook', author: 'A', publisher: 'P', language: 'English', size: '1 MB', ext: 'epub', md5: '55555555555555555555555555555555' })
    );
    const titles = parseLibgenResults(html).map(b => b.title);
    assert.deepEqual(titles, ['Ebook']);
  });

  await test('deduplicates repeated md5s across rows', async () => {
    const md5 = '66666666666666666666666666666666';
    const html = page(
      row({ title: 'First Copy', author: 'A', publisher: 'P', language: 'English', size: '1 MB', ext: 'epub', md5 }),
      row({ title: 'Second Copy', author: 'A', publisher: 'P', language: 'English', size: '1 MB', ext: 'epub', md5 })
    );
    const results = parseLibgenResults(html);
    assert.equal(results.length, 1);
  });

  await test('orders EPUB ahead of PDF, then by descending size', async () => {
    const html = page(
      row({ title: 'A Pdf', author: 'A', publisher: 'P', language: 'English', size: '9 MB', ext: 'pdf', md5: '77777777777777777777777777777777' }),
      row({ title: 'Small Epub', author: 'A', publisher: 'P', language: 'English', size: '1 MB', ext: 'epub', md5: '88888888888888888888888888888888' }),
      row({ title: 'Big Epub', author: 'A', publisher: 'P', language: 'English', size: '4 MB', ext: 'epub', md5: '99999999999999999999999999999999' })
    );
    const titles = parseLibgenResults(html).map(b => b.title);
    assert.deepEqual(titles, ['Big Epub', 'Small Epub', 'A Pdf']);
  });

  await test('an empty query never touches the network', async () => {
    let called = false;
    const results = await searchLibgen('   ', { mirrors: ['https://libgen.test'], _fetch: () => { called = true; } });
    assert.deepEqual(results, []);
    assert.equal(called, false);
  });

  await test('queries mirrors concurrently and returns the one that answers, ignoring one that errors', async () => {
    const md5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const answered = page(row({ title: 'Found', author: 'A', publisher: 'P', language: 'English', size: '1 MB', ext: 'epub', md5 }));
    const seen = [];
    const fetchMirror = async (baseUrl) => {
      seen.push(baseUrl);
      if (baseUrl === 'https://down.test') throw new Error('ECONNREFUSED');
      return answered;
    };
    const results = await searchLibgen('dune', {
      mirrors: ['https://down.test', 'https://up.test'],
      _fetchMirror: fetchMirror
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Found');
    assert.deepEqual(seen, ['https://down.test', 'https://up.test']);
  });

  await test('a clean empty page is returned as empty, not thrown', async () => {
    const results = await searchLibgen('nothingmatches', {
      mirrors: ['https://a.test', 'https://b.test'],
      _fetchMirror: async () => page()  // 200 with only the header row
    });
    assert.deepEqual(results, []);
  });

  await test('throws only when every mirror fails at the transport level', async () => {
    await assert.rejects(
      () => searchLibgen('dune', {
        mirrors: ['https://a.test', 'https://b.test'],
        _fetchMirror: async () => { throw new Error('ETIMEDOUT'); }
      }),
      /unavailable|ETIMEDOUT/
    );
  });

  await test('mirror list is configurable and falls back to the defaults', async () => {
    assert.deepEqual(configuredMirrors({ LIBGEN_MIRRORS: '' }), DEFAULT_MIRRORS);
    assert.deepEqual(
      configuredMirrors({ LIBGEN_MIRRORS: 'https://m1.test, https://m2.test/path' }),
      ['https://m1.test', 'https://m2.test']
    );
    // A junk entry alone yields the defaults rather than an empty list.
    assert.deepEqual(configuredMirrors({ LIBGEN_MIRRORS: 'not a url' }), DEFAULT_MIRRORS);
  });

  console.log(`\n${passed} passed`);
})().catch(error => { console.error(error); process.exit(1); });
