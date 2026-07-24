const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  global.window = { addEventListener() {} };
  global.document = { getElementById() { return null; } };

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'ui', 'toast.js'),
    'utf8'
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { showUndoToast } = await import(moduleUrl);

  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  const originalConsoleError = console.error;
  process.on('unhandledRejection', onUnhandled);
  console.error = () => {};
  try {
    showUndoToast('Delete pending', {
      duration: 5,
      onCommit: async () => { throw new Error('cache unavailable'); }
    });
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    console.error = originalConsoleError;
  }

  assert.deepStrictEqual(
    unhandled,
    [],
    `async toast actions must not leak unhandled rejections: ${unhandled.map(error => error.message)}`
  );
  console.log('1 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
