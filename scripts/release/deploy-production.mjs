#!/usr/bin/env node
/**
 * Promote the already-published public release to the production VPS.
 *
 * This command deliberately cannot deploy private-main-only work. It first
 * proves that private main is the durably published public-sync checkpoint
 * and that public history records that exact source revision, then runs the
 * VPS-local deploy script and verifies the deployed revision, systemd
 * service, and public health endpoint.
 *
 * Usage:
 *   npm run deploy:production -- --ssh-target user@host
 *
 * Configuration may also come from:
 *   XANDRIO_PROD_SSH_TARGET
 *   XANDRIO_PROD_DIR       (default: /opt/xandrio)
 *   XANDRIO_PROD_ORIGIN    (default: https://xandrio.xyz)
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function fail(message) {
  throw new Error(`deploy-production error: ${message}`);
}

export function validateSshTarget(value) {
  const target = String(value || '').trim();
  if (!target) fail('missing --ssh-target or XANDRIO_PROD_SSH_TARGET');
  if (!/^[A-Za-z0-9_.:@-]+$/.test(target)) fail('SSH target contains unsafe characters');
  return target;
}

export function validateRemoteDir(value) {
  const directory = String(value || '').trim();
  if (!/^\/[A-Za-z0-9_./-]+$/.test(directory) || directory.includes('..')) {
    fail('production directory must be an absolute path without shell metacharacters');
  }
  return directory.replace(/\/+$/, '');
}

export function validateProductionOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail('production origin must be a valid HTTPS origin');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    fail('production origin must be an HTTPS origin without a path, query, or fragment');
  }
  return url.origin;
}

export function assertPublicPromotionReady({
  checkpointRevision,
  sourceRevision,
  publicLog
}) {
  if (checkpointRevision !== sourceRevision) {
    fail('private main is ahead of the durable public-sync checkpoint; publish it first');
  }
  const sourceMarker = new RegExp(
    `^Xandrio-Source-Commit:\\s*${sourceRevision}$`,
    'mi'
  );
  if (!sourceMarker.test(String(publicLog || ''))) {
    fail('public/main does not record the checkpoint source revision; wait for its protected merge');
  }
}

export function assertDeploymentEvidence({
  publicRevision,
  deployedRevision,
  serviceState,
  healthStatus,
  readinessStatus,
  receipt
}) {
  if (!/^[0-9a-f]{40}$/i.test(publicRevision || '')) fail('public revision is invalid');
  if (deployedRevision !== publicRevision) {
    fail(`VPS revision ${deployedRevision || '(missing)'} does not match public/main ${publicRevision}`);
  }
  if (serviceState !== 'active') fail(`xandrio-web is ${serviceState || 'not active'}`);
  if (healthStatus < 200 || healthStatus >= 300) {
    fail(`external health check returned HTTP ${healthStatus || 'unknown'}`);
  }
  if (readinessStatus < 200 || readinessStatus >= 300) {
    fail(`external readiness check returned HTTP ${readinessStatus || 'unknown'}`);
  }
  if (receipt?.revision !== publicRevision || receipt?.status !== 'deployed' || receipt?.rolledBack) {
    fail('VPS deployment receipt does not prove a successful exact-revision deployment');
  }
  return {
    environment: 'production',
    revision: publicRevision,
    service: 'xandrio-web',
    serviceState,
    healthStatus,
    readinessStatus
  };
}

function parseArgs(argv) {
  const option = (name, fallback = '') => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    sshTarget: option('--ssh-target', process.env.XANDRIO_PROD_SSH_TARGET),
    remoteDir: option('--remote-dir', process.env.XANDRIO_PROD_DIR || '/opt/xandrio'),
    origin: option('--origin', process.env.XANDRIO_PROD_ORIGIN || 'https://xandrio.xyz'),
    dryRun: argv.includes('--dry-run')
  };
}

function run(binary, args, options = {}) {
  const output = execFileSync(binary, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...options
  });
  return typeof output === 'string' ? output.trim() : '';
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const sshTarget = validateSshTarget(config.sshTarget);
  const remoteDir = validateRemoteDir(config.remoteDir);
  const origin = validateProductionOrigin(config.origin);

  if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
    fail('production promotion must run from private main');
  }
  if (run('git', ['status', '--porcelain'])) {
    fail('working tree is not clean; commit or discard changes first');
  }
  const publicUrl = run('git', ['remote', 'get-url', 'public']);
  if (!/(^|[:/])ProofOfReach\/xandrio(?:\.git)?$/.test(publicUrl)) {
    fail(`public remote points to an unexpected repository: ${publicUrl}`);
  }

  run('git', ['fetch', 'public', 'main']);
  const base = run('git', ['rev-parse', '--verify', 'refs/tags/public-sync-base']);
  assertPublicPromotionReady({
    checkpointRevision: base,
    sourceRevision: run('git', ['rev-parse', 'main']),
    publicLog: run('git', ['log', '--format=%B', 'public/main'])
  });

  const publicRevision = run('git', ['rev-parse', 'public/main']);
  if (config.dryRun) {
    console.log(JSON.stringify({
      environment: 'production',
      action: 'dry-run',
      sshTarget,
      remoteDir,
      origin,
      expectedRevision: publicRevision
    }, null, 2));
    return;
  }

  console.log(`Deploying public/main ${publicRevision} to ${sshTarget}:${remoteDir}`);
  const deployScript = run('git', ['show', `public/main:scripts/deploy-prod.sh`]);
  run('ssh', [
    sshTarget,
    'bash',
    '-s',
    '--',
    '--root',
    remoteDir,
    '--origin',
    origin,
    publicRevision
  ], {
    input: deployScript,
    stdio: ['pipe', 'inherit', 'inherit']
  });

  const deployedRevision = run('ssh', [
    sshTarget,
    `cat ${remoteDir}/current/.xandrio-revision`
  ]);
  const serviceState = run('ssh', [
    sshTarget,
    'systemctl is-active xandrio-web'
  ]);
  const [healthResponse, readinessResponse] = await Promise.all([
    fetch(`${origin}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    }),
    fetch(`${origin}/ready`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
  ]);
  const receiptSource = run('ssh', [
    sshTarget,
    `cat ${remoteDir}/deployments/latest.json`
  ]);
  let remoteReceipt;
  try {
    remoteReceipt = JSON.parse(receiptSource);
  } catch {
    fail('VPS deployment receipt is not valid JSON');
  }
  const receipt = assertDeploymentEvidence({
    publicRevision,
    deployedRevision,
    serviceState,
    healthStatus: healthResponse.status,
    readinessStatus: readinessResponse.status,
    receipt: remoteReceipt
  });

  console.log('Production deployment verified:');
  console.log(JSON.stringify({
    ...receipt,
    origin,
    host: sshTarget,
    verifiedAt: new Date().toISOString(),
    remoteReceipt
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
