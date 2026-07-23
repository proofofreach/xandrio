const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = process.cwd();
const checker = join(root, 'scripts/release/check-docker-context.mjs');
const fixture = mkdtempSync(join(tmpdir(), 'xandrio-docker-context-'));
const requiredIgnore = [
  '.git', '.env', '.env.*', '.npmrc', 'data', 'cache', 'logs',
  'alexandrio-xandrio/data', 'tts-benchmark-samples', 'Test Books', 'node_modules',
  'kokoro-venv', 'chatterbox-venv', 'mlx-venv', '*-venv', '.claude', '.codex',
  '.clawpatch', '.playwright-cli', 'output', 'nanobanana-output', '*.pem',
  '*.key', '*.mp3', '*.wav', '*.epub', '*.pdf', '*.mobi', '*.azw3'
].join('\n') + '\n!.env.template';

function run() {
  return execFileSync('node', [checker, `--root=${fixture}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

try {
  writeFileSync(join(fixture, '.dockerignore'), `${requiredIgnore}\n`);
  writeFileSync(join(fixture, '.env.template'), 'SAFE_TEMPLATE=true\n');
  writeFileSync(join(fixture, 'app.js'), 'console.log("safe");\n');
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
