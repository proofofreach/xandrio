const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = process.cwd();
const checker = join(root, 'scripts/release/check-docker-context.mjs');
const fixture = mkdtempSync(join(tmpdir(), 'xandrio-docker-context-'));
const projectDockerIgnore = readFileSync(join(root, '.dockerignore'), 'utf8');

function run() {
  return execFileSync('node', [checker, `--root=${fixture}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

try {
  writeFileSync(join(fixture, '.dockerignore'), projectDockerIgnore);
  writeFileSync(join(fixture, '.env.template'), 'SAFE_TEMPLATE=true\n');
  writeFileSync(join(fixture, 'app.js'), 'console.log("safe");\n');
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  mkdirSync(join(fixture, 'test'), { recursive: true });
  writeFileSync(join(fixture, 'scripts', 'audit-private-import-corpus.js'), 'audit-only fixture\n');
  writeFileSync(join(fixture, 'test', 'test-import-benchmark-private.js'), 'audit-only fixture\n');
  mkdirSync(join(fixture, '.git'));
  writeFileSync(join(fixture, '.git', 'config'), 'not a real repository\n');

  const success = run();
  assert.match(success, /including untracked files/);

  writeFileSync(join(fixture, 'private-token.txt'), 'untracked secret\n');
  assert.throws(run, /sensitive file: private-token\.txt/);
  console.log('2 passed, 0 failed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
