const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../lib/write-file-atomic');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-file-atomic-'));
  try {
    const target = path.join(dir, 'artifact.json');
    await writeFileAtomic(target, '{"ok":true}');
    const stat = await fs.stat(target);
    assert.strictEqual(stat.mode & 0o777, 0o600);
    assert.strictEqual(await fs.readFile(target, 'utf8'), '{"ok":true}');

    const originalRename = fs.rename;
    fs.rename = async () => {
      const error = new Error('simulated rename failure');
      error.code = 'EPERM';
      throw error;
    };
    await assert.rejects(() => writeFileAtomic(target, '{"next":true}'));
    fs.rename = originalRename;
    const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], `rename failure leaked temps: ${leftovers}`);
    assert.strictEqual(await fs.readFile(target, 'utf8'), '{"ok":true}');
    let checkedStagedFile = false;
    await assert.rejects(writeFileAtomic(target, '{"stale":true}', {
      beforeRename: async () => {
        checkedStagedFile = (await fs.readdir(dir)).some(name => name.endsWith('.tmp'));
        throw new Error('publication was cancelled');
      }
    }), /publication was cancelled/);
    assert(checkedStagedFile);
    assert.strictEqual(await fs.readFile(target, 'utf8'), '{"ok":true}');
    assert.deepStrictEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);

    // The rename is only durable once the parent directory is fsynced.
    const originalOpen = fs.open;
    const events = [];
    fs.open = async (filePath, flags, ...rest) => {
      const handle = await originalOpen(filePath, flags, ...rest);
      if (path.resolve(filePath) === dir) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => { events.push('dir-sync'); return originalSync(); };
      }
      return handle;
    };
    const originalRenameForSync = fs.rename;
    fs.rename = async (...args) => { events.push('rename'); return originalRenameForSync(...args); };
    try {
      await writeFileAtomic(target, '{"durable":true}');
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRenameForSync;
    }
    assert.deepStrictEqual(events, ['rename', 'dir-sync'], 'fsyncs the parent directory after the rename');
    assert.strictEqual(await fs.readFile(target, 'utf8'), '{"durable":true}');
    console.log('5 passed, 0 failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
