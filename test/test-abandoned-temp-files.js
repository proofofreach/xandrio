const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { removeAbandonedJsonStoreTemps, removeAbandonedPartFiles } = require('../lib/abandoned-temp-files');

let passed = 0;
let failed = 0;

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

// A PID that belonged to a process which has already exited.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

(async () => {
  await test('removes per-writer temporaries whose owner process is gone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-abandoned-parts-'));
    try {
      const dead = deadPid();
      const live = process.ppid;
      const abandoned = [
        `abc_ch0_chunk3.mp3.${dead}.0a1b2c3d.7.part`,
        `abc_tts0123456789_ch0_chunk3.mp3.${dead}.0a1b2c3d.8.part.mp3`,
        `abc_ch0.mp3.${dead}.0a1b2c3d.part.mp3`,
        `abc_ch0.m4a.${dead}.0a1b2c3d.part.m4a`,
        `abc_ch0_concat.txt.${dead}.0a1b2c3d.tmp`,
        `abc_ch0_concat_clean.txt.${dead}.0a1b2c3d.tmp`,
        // An import's download and extracted-artifact temporaries.
        `.hash_Title.epub.${dead}.0011223344556677.part`,
        `abc.xbook.json.${dead}.0a1b2c3d.3.tmp`
      ];
      const kept = [
        // A writer in this process or another live process may still rename it.
        `abc_ch0_chunk3.mp3.${process.pid}.0a1b2c3d.7.part`,
        `abc_ch0.mp3.${process.pid}.0a1b2c3d.part.mp3`,
        `abc_ch0_concat.txt.${live}.0a1b2c3d.tmp`,
        `.hash_Title.epub.${live}.0011223344556677.part`,
        `abc.xbook.json.${process.pid}.0a1b2c3d.3.tmp`,
        // Committed artifacts and unrelated names.
        'abc_ch0_chunk3.mp3',
        'abc_ch0.mp3',
        'abc_ch0_concat.txt',
        'abc.epub',
        `notes.${dead}.0a1b2c3d.txt`,
        // The offline package sweeps its own temporaries.
        `abc_offline_0123456789abcdef_ch0.mp3.${dead}.0a1b2c3d4e5f.part.mp3`
      ];
      for (const name of [...abandoned, ...kept]) fs.writeFileSync(path.join(root, name), 'x');
      fs.mkdirSync(path.join(root, `dir_ch0.mp3.${dead}.0a1b2c3d.part.mp3`));

      const removed = await removeAbandonedPartFiles(root);
      assert.equal(removed, abandoned.length);
      for (const name of abandoned) assert.equal(fs.existsSync(path.join(root, name)), false, name);
      for (const name of kept) assert.equal(fs.existsSync(path.join(root, name)), true, name);
      assert.equal(fs.existsSync(path.join(root, `dir_ch0.mp3.${dead}.0a1b2c3d.part.mp3`)), true,
        'directories are never swept');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('removes this PID\'s temporaries only when they predate this process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-abandoned-parts-'));
    try {
      // Containers reuse PID 1 across restarts: a temp older than this
      // process cannot belong to one of its writers.
      const stale = path.join(root, `abc_ch0_chunk0.mp3.${process.pid}.0a1b2c3d.1.part`);
      const current = path.join(root, `abc_ch0_chunk1.mp3.${process.pid}.0a1b2c3d.2.part`);
      fs.writeFileSync(stale, 'x');
      fs.writeFileSync(current, 'x');
      const longAgo = new Date(Date.now() - process.uptime() * 1000 - 60_000);
      fs.utimesSync(stale, longAgo, longAgo);
      assert.equal(await removeAbandonedPartFiles(root), 1);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(current), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('sweeps json-store temporaries of dead writers from the data root only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-abandoned-json-'));
    try {
      const dead = deadPid();
      const live = process.ppid;
      const abandoned = [
        `books.json.${dead}.0a1b2c3d.7.tmp`,            // current json-store staging name
        `positions.json.${dead}.12.tmp`,                 // pre-random-component staging name
        `accounts.json.lock.${dead}.0011223344556677.tmp` // process-lock candidate
      ];
      const kept = [
        `books.json.${live}.0a1b2c3d.7.tmp`,
        `books.json.${live}.12.tmp`,
        'books.json',
        'books.json.lock',
        'books.json.lock.sqlite',
        'books.json.initialized',
        'books.json.corrupt-abcdef12',
        `notes.${dead}.tmp`
      ];
      for (const name of [...abandoned, ...kept]) fs.writeFileSync(path.join(root, name), 'x');
      fs.mkdirSync(path.join(root, 'runtime'));
      fs.writeFileSync(path.join(root, 'runtime', `state.json.${dead}.0a1b2c3d.1.tmp`), 'x');

      assert.equal(await removeAbandonedJsonStoreTemps(root), abandoned.length);
      const remaining = fs.readdirSync(root).sort();
      assert.deepEqual(remaining, [...kept, 'runtime'].sort());
      assert.deepEqual(fs.readdirSync(path.join(root, 'runtime')), [`state.json.${dead}.0a1b2c3d.1.tmp`],
        'subdirectories are left alone');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('a missing cache directory sweeps nothing', async () => {
    assert.equal(await removeAbandonedPartFiles(path.join(os.tmpdir(), 'xandrio-missing-cache-dir-xyz')), 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
