#!/usr/bin/env node
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

let passed = 0;
let failed = 0;

async function check(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

(async () => {
  const deployment = await import(pathToFileURL(resolve(
    __dirname,
    '..',
    'scripts',
    'release',
    'deploy-production.mjs'
  )));

  await check('accepts bounded production connection settings', () => {
    assert.equal(deployment.validateSshTarget('deploy@203.0.113.10'), 'deploy@203.0.113.10');
    assert.equal(deployment.validateRemoteDir('/opt/xandrio/'), '/opt/xandrio');
    assert.equal(
      deployment.validateProductionOrigin('https://xandrio.xyz'),
      'https://xandrio.xyz'
    );
  });

  await check('rejects shell injection and non-origin production URLs', () => {
    assert.throws(() => deployment.validateSshTarget('root@host; reboot'), /unsafe/);
    assert.throws(() => deployment.validateRemoteDir('/opt/../root'), /absolute path/);
    assert.throws(
      () => deployment.validateProductionOrigin('https://xandrio.xyz/health'),
      /HTTPS origin/
    );
  });

  await check('detects private patches absent from public main', () => {
    assert.deepEqual(
      deployment.pendingPublicPatches(
        '- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
        '+ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
      ),
      ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
    );
  });

  await check('requires matching VPS revision, active service, and external health', () => {
    const revision = 'a'.repeat(40);
    assert.deepEqual(deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'active',
      healthStatus: 200
    }), {
      environment: 'production',
      revision,
      service: 'xandrio-web',
      serviceState: 'active',
      healthStatus: 200
    });
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: 'b'.repeat(40),
      serviceState: 'active',
      healthStatus: 200
    }), /does not match/);
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'inactive',
      healthStatus: 200
    }), /inactive/);
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'active',
      healthStatus: 503
    }), /HTTP 503/);
  });

  await check('VPS deploy keeps repository writes under the checkout owner', () => {
    const scriptPath = resolve(__dirname, '..', 'scripts', 'deploy-prod.sh');
    const source = readFileSync(scriptPath, 'utf8');
    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.match(source, /REPO_RUN=\(\)/);
    assert.match(source, /REPO_RUN=\(runuser -u "\$REPO_OWNER" --\)/);
    assert.match(source, /repo git fetch --tags origin/);
    assert.match(source, /repo git checkout --detach "\$REF"/);
    assert.match(source, /repo npm ci --omit=dev/);
    assert.match(source, /\$SUDO systemctl restart "\$SERVICE"/);
  });

  await check('production receipt reads the detached revision without root-owned Git access', () => {
    const source = readFileSync(resolve(
      __dirname,
      '..',
      'scripts',
      'release',
      'deploy-production.mjs'
    ), 'utf8');
    assert.match(source, /`cat \$\{remoteDir\}\/\.git\/HEAD`/);
    assert.doesNotMatch(source, /cd \$\{remoteDir\} && git rev-parse HEAD/);
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
