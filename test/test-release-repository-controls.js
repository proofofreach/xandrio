#!/usr/bin/env node
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
  *) echo "unexpected endpoint: $endpoint" >&2; exit 2 ;;
esac
cat "$GH_FIXTURE_DIR/$file.json"
`);
  chmodSync(gh, 0o700);

  write('repository', { visibility: 'public', private: false, default_branch: 'main' });
  write('protection', {
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
  });
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
