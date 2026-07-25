const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

(async () => {
  let source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'features', 'sharing.js'),
    'utf8'
  );
  source = source.replace(
    "import { showToast } from '../ui/toast.js';",
    'const showToast = () => {};'
  );
  const sharing = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  await test('builds a stable encoded player deep link', () => {
    const locationLike = { href: 'https://reader.test/app?mode=pwa#/library' };
    assert.strictEqual(
      sharing.bookShareURL('book / one', locationLike),
      'https://reader.test/app#/player/book%20%2F%20one'
    );
  });

  await test('uses the native share sheet with title, author, and URL', async () => {
    let payload;
    const result = await sharing.shareBook(
      { id: 'book-1', title: 'The Book', author: 'A. Writer' },
      {
        navigatorLike: { share: async value => { payload = value; } },
        documentLike: {},
        locationLike: { href: 'https://reader.test/#/library' },
        notify: () => { throw new Error('should not notify'); }
      }
    );
    assert.strictEqual(result, 'shared');
    assert.deepStrictEqual(payload, {
      title: 'The Book',
      text: 'The Book by A. Writer',
      url: 'https://reader.test/#/player/book-1'
    });
  });

  await test('treats a cancelled native share as a no-op', async () => {
    let copied = false;
    const result = await sharing.shareBook(
      { id: 'book-1', title: 'The Book' },
      {
        navigatorLike: {
          share: async () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            throw error;
          },
          clipboard: { writeText: async () => { copied = true; } }
        },
        documentLike: {},
        locationLike: { href: 'https://reader.test/' },
        notify: () => { throw new Error('should not notify'); }
      }
    );
    assert.strictEqual(result, 'cancelled');
    assert.strictEqual(copied, false);
  });

  await test('copies the link when native sharing is unavailable', async () => {
    let copied = '';
    const notifications = [];
    const result = await sharing.shareBook(
      { id: 'book-2', title: 'Another Book' },
      {
        navigatorLike: { clipboard: { writeText: async value => { copied = value; } } },
        documentLike: {},
        locationLike: { href: 'https://reader.test/#/library' },
        notify: (...args) => notifications.push(args)
      }
    );
    assert.strictEqual(result, 'copied');
    assert.strictEqual(copied, 'https://reader.test/#/player/book-2');
    assert.deepStrictEqual(notifications, [['Book link copied']]);
  });

  await test('falls back to a temporary copy field when clipboard permission is denied', async () => {
    let selected = false;
    let removed = false;
    const field = {
      value: '',
      style: {},
      setAttribute() {},
      select() { selected = true; },
      remove() { removed = true; }
    };
    const result = await sharing.shareBook(
      { id: 'book-legacy', title: 'Legacy Copy' },
      {
        navigatorLike: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
        documentLike: {
          body: { appendChild() {} },
          createElement: () => field,
          execCommand: command => command === 'copy'
        },
        locationLike: { href: 'https://reader.test/' },
        notify: () => {}
      }
    );
    assert.strictEqual(result, 'copied');
    assert.strictEqual(field.value, 'https://reader.test/#/player/book-legacy');
    assert.strictEqual(selected, true);
    assert.strictEqual(removed, true);
  });

  await test('reports clipboard failure without throwing', async () => {
    const notifications = [];
    const result = await sharing.shareBook(
      { id: 'book-3', title: 'Uncopyable' },
      {
        navigatorLike: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
        documentLike: {},
        locationLike: { href: 'https://reader.test/' },
        notify: (...args) => notifications.push(args)
      }
    );
    assert.strictEqual(result, 'failed');
    assert.deepStrictEqual(notifications, [['Could not share this book', 'error']]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
