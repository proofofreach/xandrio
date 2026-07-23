#!/usr/bin/env node
/** Scan every ref in a Git repository with a checksum-pinned Gitleaks binary. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = '8.30.1';
const RELEASE_BASE = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}`;
const ARCHIVES = new Map([
  ['darwin-arm64', {
    name: `gitleaks_${VERSION}_darwin_arm64.tar.gz`,
    sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'
  }],
  ['darwin-x64', {
    name: `gitleaks_${VERSION}_darwin_x64.tar.gz`,
    sha256: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'
  }],
  ['linux-arm64', {
    name: `gitleaks_${VERSION}_linux_arm64.tar.gz`,
    sha256: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'
  }],
  ['linux-x64', {
    name: `gitleaks_${VERSION}_linux_x64.tar.gz`,
    sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
  }]
]);

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

function fail(message) {
  console.error(`history scan error: ${message}`);
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
    throw new Error(`${basename(binary)} exited with status ${result.status}`);
  }
  return result.stdout?.trim() || '';
}

async function installPinnedGitleaks() {
  const key = `${process.platform}-${process.arch}`;
  const artifact = ARCHIVES.get(key);
  if (!artifact) {
    throw new Error(`no pinned Gitleaks archive is configured for ${key}; pass --gitleaks /absolute/path`);
  }

  const directory = mkdtempSync(resolve(tmpdir(), 'xandrio-gitleaks-'));
  const archive = resolve(directory, artifact.name);
  const response = await fetch(`${RELEASE_BASE}/${artifact.name}`, { redirect: 'follow' });
  if (!response.ok) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Gitleaks download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Gitleaks archive checksum mismatch: expected ${artifact.sha256}, received ${digest}`);
  }
  writeFileSync(archive, bytes, { mode: 0o600 });
  run('tar', ['-xzf', archive, '-C', directory, 'gitleaks']);
  const binary = resolve(directory, 'gitleaks');
  chmodSync(binary, 0o700);
  return { binary, directory, artifact };
}

const repository = resolve(option('--repo') || resolve(import.meta.dirname, '..', '..'));
const config = resolve(repository, '.gitleaks.toml');
let installation;

try {
  run('git', ['-C', repository, 'rev-parse', '--git-dir']);
  readFileSync(config, 'utf8');

  const supplied = option('--gitleaks') || process.env.GITLEAKS_BIN;
  installation = supplied
    ? { binary: resolve(supplied), directory: null, artifact: null }
    : await installPinnedGitleaks();

  const version = run(installation.binary, ['version']);
  console.log(`Scanning every Git ref in ${repository} with Gitleaks ${version}.`);
  run(installation.binary, [
    'git',
    '--config', config,
    '--redact',
    '--no-banner',
    '--no-color',
    '--timeout=300',
    '--log-opts=--all',
    repository
  ], { cwd: repository, inherit: true });
  console.log('Full-ref Git history scan passed.');
} catch (error) {
  fail(error.message);
} finally {
  if (installation?.directory) rmSync(installation.directory, { recursive: true, force: true });
}
