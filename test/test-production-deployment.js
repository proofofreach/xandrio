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

  await check('requires an exact durable checkpoint recorded on public main', () => {
    const revision = 'a'.repeat(40);
    assert.throws(() => deployment.assertPublicPromotionReady({
      checkpointRevision: revision,
      sourceRevision: 'b'.repeat(40),
      publicLog: ''
    }), /ahead of the durable public-sync checkpoint/);
    assert.throws(() => deployment.assertPublicPromotionReady({
      checkpointRevision: revision,
      sourceRevision: revision,
      publicLog: ''
    }), /does not record/);
    assert.doesNotThrow(() => deployment.assertPublicPromotionReady({
      checkpointRevision: revision,
      sourceRevision: revision,
      publicLog: `Release\n\nXandrio-Source-Commit: ${revision}\n`
    }));
  });

  await check('requires matching VPS revision, active service, and external health', () => {
    const revision = 'a'.repeat(40);
    assert.deepEqual(deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'active',
      healthStatus: 200,
      readinessStatus: 200,
      receipt: { status: 'deployed', revision, rolledBack: false }
    }), {
      environment: 'production',
      revision,
      service: 'xandrio-web',
      serviceState: 'active',
      healthStatus: 200,
      readinessStatus: 200
    });
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: 'b'.repeat(40),
      serviceState: 'active',
      healthStatus: 200,
      readinessStatus: 200,
      receipt: { status: 'deployed', revision, rolledBack: false }
    }), /does not match/);
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'inactive',
      healthStatus: 200,
      readinessStatus: 200,
      receipt: { status: 'deployed', revision, rolledBack: false }
    }), /inactive/);
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'active',
      healthStatus: 503,
      readinessStatus: 200,
      receipt: { status: 'deployed', revision, rolledBack: false }
    }), /HTTP 503/);
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'active',
      healthStatus: 200,
      readinessStatus: 503,
      receipt: { status: 'deployed', revision, rolledBack: false }
    }), /readiness/);
    assert.throws(() => deployment.assertDeploymentEvidence({
      publicRevision: revision,
      deployedRevision: revision,
      serviceState: 'active',
      healthStatus: 200,
      readinessStatus: 200,
      receipt: { status: 'rolled-back', revision, rolledBack: true }
    }), /receipt/);
  });

  await check('VPS deploy stages an exact revision under the checkout owner', () => {
    const scriptPath = resolve(__dirname, '..', 'scripts', 'deploy-prod.sh');
    const source = readFileSync(scriptPath, 'utf8');
    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.match(source, /REPO_RUN=\(\)/);
    assert.match(source, /REPO_RUN=\(runuser -u "\$REPO_OWNER" --\)/);
    assert.match(source, /repo git -C "\$REPO_ROOT" fetch --tags origin main/);
    assert.match(source, /worktree add --detach "\$RELEASE_DIR" "\$REVISION"/);
    assert.match(source, /repo npm ci --omit=dev --prefix "\$RELEASE_DIR"/);
    assert.match(source, /\$SUDO systemctl restart "\$SERVICE"/);
  });

  await check('production deploy is locked, atomic, readiness-gated, and self-rolling-back', () => {
    const scriptPath = resolve(__dirname, '..', 'scripts', 'deploy-prod.sh');
    const source = readFileSync(scriptPath, 'utf8');
    const dryRun = spawnSync('bash', [
      scriptPath,
      '--root',
      resolve(__dirname, '..'),
      '--origin',
      'https://reader.example.com',
      '--dry-run',
      'a'.repeat(40)
    ], { encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /exact revision/);
    assert.match(dryRun.stdout, /rollback:\s+automatic/);
    assert.match(source, /flock -n 9/);
    assert.match(source, /mv -Tf "\$CURRENT_LINK\.next" "\$CURRENT_LINK"/);
    assert.match(source, /http:\/\/127\.0\.0\.1:\$PORT\/ready/);
    assert.match(source, /rollback\(\)/);
    assert.match(source, /write_receipt "rolled-back" true/);
  });

  await check('production receipt reads the active release without root-owned Git access', () => {
    const source = readFileSync(resolve(
      __dirname,
      '..',
      'scripts',
      'release',
      'deploy-production.mjs'
    ), 'utf8');
    assert.match(source, /`cat \$\{remoteDir\}\/current\/\.xandrio-revision`/);
    assert.match(source, /`cat \$\{remoteDir\}\/deployments\/latest\.json`/);
    assert.match(source, /public\/main:scripts\/deploy-prod\.sh/);
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
