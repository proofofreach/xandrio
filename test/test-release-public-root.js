#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');

const prepareScript = resolve(__dirname, '..', 'scripts', 'release', 'prepare-public-root.mjs');
let passed = 0;
let failed = 0;

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}

function check(name, callback) {
  try {
    callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function invoke(source, output, gitleaks, env = {}) {
  return spawnSync(process.execPath, [
    prepareScript,
    '--source-root', source,
    '--output', output,
    '--gitleaks', gitleaks
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

const fixture = mkdtempSync(resolve(tmpdir(), 'xandrio-release-root-test-'));
const source = resolve(fixture, 'private-source');
const output = resolve(fixture, 'public-root');
const fakeGitleaks = resolve(fixture, 'gitleaks');
const gitleaksLog = resolve(fixture, 'gitleaks.log');

try {
  mkdirSync(resolve(source, 'scripts', 'release'), { recursive: true });
  for (const file of [
    'verify-release-consistency.mjs',
    'check-docker-context.mjs',
    'check-release-assets.mjs',
    'check-release-approvals.mjs',
    'check-release-contacts.mjs'
  ]) {
    writeFileSync(resolve(source, 'scripts', 'release', file), "console.log('fixture gate passed');\n");
  }
  writeFileSync(resolve(source, 'scripts', 'release', 'scan-git-history.mjs'), '// required export fixture\n');
  writeFileSync(resolve(source, 'LICENSE'), 'fixture licence\n');
  writeFileSync(resolve(source, 'package.json'), '{"name":"release-root-fixture","version":"1.0.0"}\n');
  writeFileSync(resolve(source, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
  writeFileSync(resolve(source, 'historical-secret.txt'), 'removed before the public snapshot\n');

  execFileSync('git', ['init', '--initial-branch=main', source]);
  git(source, ['config', 'user.name', 'Release Fixture']);
  git(source, ['config', 'user.email', 'release-fixture@example.invalid']);
  git(source, ['add', '--all']);
  git(source, ['commit', '-m', 'private historical state']);
  unlinkSync(resolve(source, 'historical-secret.txt'));
  writeFileSync(resolve(source, 'current.txt'), 'public snapshot content\n');
  git(source, ['add', '--all']);
  git(source, ['commit', '-m', 'reviewed source state']);

  writeFileSync(fakeGitleaks, `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "8.30.1-test"
  exit 0
fi
printf '%s\\n' "$*" >> "$GITLEAKS_TEST_LOG"
exit 0
`);
  chmodSync(fakeGitleaks, 0o700);

  check('exports exactly one root commit and excludes removed private history', () => {
    const result = invoke(source, output, fakeGitleaks, { GITLEAKS_TEST_LOG: gitleaksLog });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(git(output, ['rev-list', '--all', '--count']), '1');
    assert.equal(git(output, ['status', '--porcelain=v1']), '');
    assert.equal(existsSync(resolve(output, 'historical-secret.txt')), false);
    assert.equal(readFileSync(resolve(output, 'current.txt'), 'utf8'), 'public snapshot content\n');
    assert.equal(git(output, ['log', '--all', '--format=%H', '--', 'historical-secret.txt']), '');
    assert.match(readFileSync(gitleaksLog, 'utf8'), /--log-opts=--all/);
  });

  check('refuses a dirty private source and removes no pre-existing data', () => {
    writeFileSync(resolve(source, 'dirty.txt'), 'not committed\n');
    const dirtyOutput = resolve(fixture, 'dirty-output');
    const result = invoke(source, dirtyOutput, fakeGitleaks);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source worktree is not clean/);
    assert.equal(existsSync(dirtyOutput), false);
    unlinkSync(resolve(source, 'dirty.txt'));
  });

  check('refuses to create the public root inside the private repository', () => {
    const unsafeOutput = resolve(source, 'public');
    const result = invoke(source, unsafeOutput, fakeGitleaks);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be outside the private source repository/);
    assert.equal(existsSync(unsafeOutput), false);
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
