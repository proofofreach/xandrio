const assert = require('node:assert/strict');
const { checkNodeVersion, createRuntimeDependencyCheck, parseRange } = require('../lib/runtime-dependencies');

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

function fakeExecFile(available) {
  const calls = [];
  const execFile = (name, args, options, callback) => {
    calls.push({ name, args });
    if (available.includes(name)) callback(null, `${name} version 7.1\nbuilt with gcc`);
    else callback(Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' }));
  };
  return { execFile, calls };
}

(async () => {
  await test('node version: too old fails, inside passes, newer than the range only warns', () => {
    const engines = { node: '>=24.22.1 <25' };
    assert.deepEqual(
      [checkNodeVersion({ version: 'v22.0.0', engines }).ok, checkNodeVersion({ version: 'v22.0.0', engines }).tooOld],
      [false, true]
    );
    assert.equal(checkNodeVersion({ version: 'v24.22.1', engines }).ok, true);
    assert.equal(checkNodeVersion({ version: 'v24.22.0', engines }).ok, false);
    const newer = checkNodeVersion({ version: 'v26.1.0', engines });
    assert.deepEqual([newer.ok, newer.satisfied, newer.tooOld], [true, false, false]);
    assert.match(newer.detail, /outside engines.node/);
    assert.equal(checkNodeVersion({ version: 'v1.0.0', engines: {} }).ok, true);
    assert.equal(checkNodeVersion({ version: 'v1.0.0', engines: { node: '^24 || ^26' } }).ok, true, 'unparseable ranges are not enforced');
    assert.equal(parseRange('>=24.22.1 <25').length, 2);
    assert.equal(parseRange('^24'), null);
  });

  await test('missing ffmpeg or ffprobe fails the check and the verdict is cached', async () => {
    const { execFile, calls } = fakeExecFile(['ffmpeg']);
    const check = createRuntimeDependencyCheck({
      engines: { node: '>=1' }, version: 'v24.0.0', execFile, log: { warn() {}, error() {} }
    });
    const result = await check.check();
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, ['ffprobe is not installed or not on PATH']);
    assert.deepEqual(calls.map(call => call.name), ['ffmpeg', 'ffprobe']);
    assert.deepEqual(calls.map(call => call.args), [['-version'], ['-version']]);
    await check.check();
    assert.equal(calls.length, 2, 'probes run once');
    await check.refresh();
    assert.equal(calls.length, 4, 'refresh re-probes');
  });

  await test('all dependencies present reports ok with the node warning carried along', async () => {
    const warnings = [];
    const { execFile } = fakeExecFile(['ffmpeg', 'ffprobe']);
    const check = createRuntimeDependencyCheck({
      engines: { node: '>=24 <25' }, version: 'v26.0.0', execFile, log: { warn: message => warnings.push(message), error() {} }
    });
    const result = await check.check();
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.warnings.length, 1);
    assert.match(warnings[0], /outside engines.node/);
    assert.equal(result.binaries[0].detail, 'ffmpeg version 7.1');
  });

  console.log(`runtime-dependencies tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
