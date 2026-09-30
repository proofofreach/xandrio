#!/usr/bin/env node
// Failure modes: sole owner cannot release; an additional writer or organization
// bypasses independent review; an unrelated release approver is accepted;
// missing CI strictness or conversation resolution is accepted in owner mode.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, resolve } = require('node:path');

const checkScript = resolve(__dirname, '..', 'scripts', 'release', 'check-public-repository.mjs');
let passed = 0;
let failed = 0;

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

const fixture = mkdtempSync(resolve(tmpdir(), 'xandrio-repository-controls-'));
const bin = resolve(fixture, 'bin');
mkdirSync(bin);
const gh = resolve(bin, 'gh');

function write(name, value) {
  writeFileSync(resolve(fixture, `${name}.json`), `${JSON.stringify(value)}\n`);
}

function invoke() {
  return spawnSync(process.execPath, [checkScript, '--repo', 'Example/xandrio'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_TOKEN: 'fixture-token',
      GH_FIXTURE_DIR: fixture,
      PATH: `${bin}${delimiter}${process.env.PATH}`
    }
  });
}

try {
  writeFileSync(gh, `#!/bin/sh
endpoint=""
for argument in "$@"; do endpoint="$argument"; done
case "$endpoint" in
  repos/Example/xandrio) file="repository" ;;
  repos/Example/xandrio/branches/main/protection) file="protection" ;;
  repos/Example/xandrio/environments/release) file="environment" ;;
  repos/Example/xandrio/actions/permissions/workflow) file="workflow" ;;
  repos/Example/xandrio/collaborators?per_page=100) file="collaborators" ;;
  *) echo "unexpected endpoint: $endpoint" >&2; exit 2 ;;
esac
cat "$GH_FIXTURE_DIR/$file.json"
`);
  chmodSync(gh, 0o700);

  const repository = { visibility: 'public', private: false, default_branch: 'main', owner: { login: 'Example', type: 'User' } };
  const protection = {
    enforce_admins: { enabled: true },
    required_status_checks: { strict: true, contexts: ['verify', 'dependency-review'] },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true
    },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
  write('repository', repository);
  write('protection', protection);
  write('collaborators', [
    { login: 'Example', permissions: { admin: true } },
    { login: 'maintainer', permissions: { push: true } }
  ]);
  write('environment', {
    protection_rules: [{
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { login: 'release-owner' } }]
    }]
  });
  write('workflow', {
    default_workflow_permissions: 'read',
    can_approve_pull_request_reviews: false
  });

  check('accepts a public repository with enforced branch and release controls', () => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Public repository controls passed/);
  });

  check('rejects a release environment that permits self-review', () => {
    write('environment', {
      protection_rules: [{
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [{ type: 'User', reviewer: { login: 'release-owner' } }]
      }]
    });
    const result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permits self-review/);
  });

  const ownerEnvironment = { protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
    reviewers: [{ type: 'User', reviewer: { login: 'Example' } }] }] };
  const ownerProtection = { ...protection, required_pull_request_reviews: null };
  write('collaborators', [{ login: 'Example', permissions: { admin: true } }]);
  write('protection', ownerProtection);
  write('environment', ownerEnvironment);
  check('accepts sole-owner releases with enforced CI and owner approval', () => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /sole-owner/);
  });
  check('a second writer restores the independent review requirement', () => {
    write('collaborators', [{ login: 'Example', permissions: { admin: true } },
      { login: 'second', permissions: { push: true } }]);
    assert.notEqual(invoke().status, 0);
  });
  write('collaborators', [{ login: 'Example', permissions: { admin: true } }]);
  check('a release approver must be the sole owner', () => {
    write('environment', { protection_rules: [{ ...ownerEnvironment.protection_rules[0],
      reviewers: [{ type: 'User', reviewer: { login: 'unrelated' } }] }] });
    assert.notEqual(invoke().status, 0);
  });
  write('environment', ownerEnvironment);
  check('organizations cannot use sole-owner release mode', () => {
    write('repository', { ...repository, owner: { login: 'Example', type: 'Organization' } });
    assert.notEqual(invoke().status, 0);
  });
  write('repository', repository);
  check('sole-owner mode still requires strict CI', () => {
    write('protection', { ...ownerProtection, required_status_checks: { strict: false, contexts: ['verify', 'dependency-review'] } });
    assert.notEqual(invoke().status, 0);
  });
  check('sole-owner mode still requires resolved conversations', () => {
    write('protection', { ...ownerProtection, required_conversation_resolution: { enabled: false } });
    assert.notEqual(invoke().status, 0);
  });

  check('rejects publication from a private repository', () => {
    write('repository', { visibility: 'private', private: true, default_branch: 'main' });
    const result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not public/);
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
