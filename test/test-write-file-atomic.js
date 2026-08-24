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
    console.log('3 passed, 0 failed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
