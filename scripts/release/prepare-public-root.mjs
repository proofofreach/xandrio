#!/usr/bin/env node
/**
 * Export one reviewed source commit into a new one-commit Git repository.
 * This never creates a remote and refuses dirty or release-blocked sources.
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptRoot = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

function fail(message) {
  console.error(`public-root preparation error: ${message}`);
  process.exit(1);
}

function run(binary, commandArgs, options = {}) {
  const result = spawnSync(binary, commandArgs, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!options.inherit) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${binary} ${commandArgs[0] || ''} exited with status ${result.status}`);
  }
  return result.stdout?.trim() || '';
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

const sourceRoot = resolve(option('--source-root') || scriptRoot);
const sourceRef = option('--source-ref') || 'HEAD';
const outputArgument = option('--output');
const gitleaks = option('--gitleaks');

if (!outputArgument) fail('--output /absolute/path is required');
const output = resolve(outputArgument);
if (isInside(sourceRoot, output)) fail('the public root must be outside the private source repository');
if (existsSync(output)) fail(`output already exists: ${output}`);

let temp;
let createdOutput = false;
try {
  run('git', ['-C', sourceRoot, 'rev-parse', '--git-dir']);
  const status = run('git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=normal']);
  if (status) throw new Error('source worktree is not clean');

  const sourceCommit = run('git', ['-C', sourceRoot, 'rev-parse', `${sourceRef}^{commit}`]);
  const configuredName = run('git', ['-C', sourceRoot, 'config', 'user.name']);
  const configuredEmail = run('git', ['-C', sourceRoot, 'config', 'user.email']);
  if (!configuredName || !configuredEmail) throw new Error('Git user.name and user.email must identify the release owner');

  const gates = [
    'scripts/release/verify-release-consistency.mjs',
    'scripts/release/check-docker-context.mjs',
    'scripts/release/check-release-assets.mjs',
    'scripts/release/check-release-approvals.mjs',
    'scripts/release/check-release-contacts.mjs'
  ];
  for (const gate of gates) {
    run(process.execPath, [resolve(sourceRoot, gate)], { cwd: sourceRoot, inherit: true });
  }

  temp = mkdtempSync(resolve(tmpdir(), 'xandrio-public-root-'));
  const archive = resolve(temp, 'source.tar');
  run('git', ['-C', sourceRoot, 'archive', '--format=tar', `--output=${archive}`, sourceCommit]);
  mkdirSync(output, { recursive: false });
  createdOutput = true;
  run('tar', ['-xf', archive, '-C', output]);

  for (const required of ['LICENSE', 'package.json', '.gitleaks.toml', 'scripts/release/scan-git-history.mjs']) {
    if (!existsSync(resolve(output, required))) throw new Error(`export is missing required file: ${required}`);
  }

  run('git', ['-C', output, 'init', '--initial-branch=main']);
  run('git', ['-C', output, 'config', 'user.name', configuredName]);
  run('git', ['-C', output, 'config', 'user.email', configuredEmail]);
  run('git', ['-C', output, 'add', '--all']);
  run('git', ['-C', output, 'commit', '--no-gpg-sign', '-m', 'release: create sanitized public source root']);

  const scannerArgs = [resolve(scriptRoot, 'scripts/release/scan-git-history.mjs'), '--repo', output];
  if (gitleaks) scannerArgs.push('--gitleaks', resolve(gitleaks));
  run(process.execPath, scannerArgs, { cwd: scriptRoot, inherit: true });

  const commitCount = Number(run('git', ['-C', output, 'rev-list', '--all', '--count']));
  if (commitCount !== 1) throw new Error(`sanitized repository has ${commitCount} commits instead of exactly one`);
  if (run('git', ['-C', output, 'status', '--porcelain=v1'])) throw new Error('sanitized repository is unexpectedly dirty');

  const publicCommit = run('git', ['-C', output, 'rev-parse', 'HEAD']);
  console.log(JSON.stringify({ sourceCommit, publicCommit, output, commitCount }, null, 2));
  console.log('Sanitized public root prepared locally. No remote was created or modified.');
} catch (error) {
  if (createdOutput) rmSync(output, { recursive: true, force: true });
  fail(error.message);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
