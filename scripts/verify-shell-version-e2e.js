'use strict';
// CLI E2E, all failure cases recorded before helper edits in the repair manifest.
// Operates only on temporary copies of the actual public shell and helper.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const paths = ['public/index.html', 'public/sw.js', 'public/js/features/offline.js'];
const baseline = process.argv.includes('--baseline');
const output = path.join(root, 'output/ui-rewrite-fixes', `shell-version-${baseline ? 'before' : 'after'}.json`);
const versions = sw => Object.fromEntries([...sw.match(/const ASSET_VERSIONS = \{([\s\S]*?)\};/)[1].matchAll(/['"]([^'"]+)['"]:\s*(\d+)/g)].map(([, asset, value]) => [asset, Number(value)]));
const digest = text => createHash('sha256').update(text).digest('hex');

(async () => {
  const original = Object.fromEntries(await Promise.all(paths.map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')])));
  let helper = await fs.readFile(path.join(root, 'scripts/bump-version.mjs'), 'utf8');
  if (baseline) {
    const prior = spawnSync('git', ['show', '91a6d38:scripts/bump-version.mjs'], { cwd: root, encoding: 'utf8' });
    assert.equal(prior.status, 0); helper = prior.stdout;
  }
  const report = { baseline, passed: false, checks: [] };
  const initial = versions(original['public/sw.js']);
  async function check(name, args, mutate, verify) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-shell-version-'));
    try {
      const files = { ...original }; mutate?.(files);
      for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text); }
      await fs.mkdir(path.join(dir, 'scripts')); await fs.writeFile(path.join(dir, 'scripts/bump-version.mjs'), helper);
      const run = spawnSync(process.execPath, ['scripts/bump-version.mjs', ...args], { cwd: dir, encoding: 'utf8', timeout: 5000 });
      const after = Object.fromEntries(await Promise.all(paths.map(async file => [file, await fs.readFile(path.join(dir, file), 'utf8')])));
      try {
        verify({ files, after, run }); report.checks.push({ name, passed: true, stdout: run.stdout, stderr: run.stderr, beforeHashes: Object.fromEntries(paths.map(file => [file, digest(files[file])])), afterHashes: Object.fromEntries(paths.map(file => [file, digest(after[file])])) }); console.log(`PASS ${name}`);
      } catch (error) { report.checks.push({ name, passed: false, error: error.message, stdout: run.stdout, stderr: run.stderr }); console.log(`FAIL ${name}: ${error.message}`); }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  function successful({ after, run }, targets) {
    assert.equal(run.status, 0, run.stderr);
    const next = versions(after['public/sw.js']);
    assert.equal(Object.keys(next).length, Object.keys(initial).length);
    for (const [asset, version] of Object.entries(initial)) {
      const expected = version + Number(targets.has(asset)); assert.equal(next[asset], expected, `${asset} map version`);
      assert(after['public/index.html'].includes(`${asset.slice(1)}?v=${expected}`), `${asset} HTML version`);
    }
    const cache = after['public/sw.js'].match(/const CACHE_VERSION = '(xandrio-v(\d+))';/);
    const old = original['public/sw.js'].match(/const CACHE_VERSION = 'xandrio-v(\d+)';/);
    assert.equal(Number(cache[2]), Number(old[1]) + 1);
    assert(after['public/js/features/offline.js'].includes(`EXPECTED_OFFLINE_SW_VERSION = '${cache[1]}'`));
  }
  function rejectWithoutWrites({ files, after, run }) { assert.notEqual(run.status, 0, 'expected refusal'); assert.deepEqual(after, files, 'failed validation changed files'); }
  await check('default bumps every versioned shell asset', [], null, result => successful(result, new Set(Object.keys(initial))));
  await check('explicit new stylesheet bumps only that asset', ['player.css'], null, result => successful(result, new Set(['/player.css'])));
  await check('mixed valid and unknown arguments reject without writes', ['app.js', 'unknown.css'], null, rejectWithoutWrites);
  await check('unselected HTML version mismatch rejects without writes', ['app.js'], files => { files['public/index.html'] = files['public/index.html'].replace(/player\.css\?v=\d+/, 'player.css?v=999999'); }, rejectWithoutWrites);
  await check('map mismatch rejects without writes', [], files => { files['public/sw.js'] = files['public/sw.js'].replace(/('\/player.css':\s*)\d+/, '$1999999'); }, rejectWithoutWrites);
  await check('missing shell entry rejects without writes', ['app.js'], files => { files['public/sw.js'] = files['public/sw.js'].replace("  versionedAsset('/player.css'),\n", ''); }, rejectWithoutWrites);
  await check('controller pin mismatch rejects without writes', [], files => { files['public/js/features/offline.js'] = files['public/js/features/offline.js'].replace(/EXPECTED_OFFLINE_SW_VERSION = '[^']+'/, "EXPECTED_OFFLINE_SW_VERSION = 'xandrio-v0'"); }, rejectWithoutWrites);
  report.passed = report.checks.every(check => check.passed);
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Shell version CLI: ${report.checks.filter(check => check.passed).length}/${report.checks.length} passed; ${output}`);
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
