const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const locks = [
  ['kokoro', 'requirements-kokoro.txt', 'requirements-kokoro.in', /Linux x86_64 \/ CPython 3\.12/, 'Dockerfile.kokoro'],
  ['chatterbox', 'requirements-chatterbox.txt', 'requirements-chatterbox.in', /Linux x86_64 \/ CPython 3\.12/, 'Dockerfile.chatterbox'],
  ['kokoro macOS', 'requirements-kokoro-macos-arm64.txt', 'requirements-kokoro-macos-arm64.in', /macOS 14\+ \/ Apple Silicon \/ CPython 3\.12/],
  ['chatterbox MLX', 'requirements-chatterbox-mlx.txt', 'requirements-chatterbox-mlx.in', /macOS 14\+ \/ Apple Silicon \/ CPython 3\.14/]
];
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, 'python', file), 'utf8');
}

for (const [engine, lockFile, sourceFile, platformPattern, dockerfile] of locks) {
  const lock = read(lockFile);
  const source = read(sourceFile);
  const docker = dockerfile ? read(dockerfile) : null;

  test(`${engine} lock is complete and hash checked`, () => {
    assert.match(lock, platformPattern);
    assert.match(lock, /^--index-url https:\/\/pypi\.org\/simple$/m);
    if (docker) assert.match(lock, /^--extra-index-url https:\/\/download\.pytorch\.org\/whl\/cpu$/m);
    assert.doesNotMatch(lock, /^\s*-c\s+/m);

    const records = [...lock.matchAll(/^([A-Za-z0-9_.-]+)==[^\s\\]+/gm)];
    assert(records.length > 30, 'lock should contain the resolved transitive graph');
    for (let index = 0; index < records.length; index += 1) {
      const start = records[index].index;
      const end = index + 1 < records.length ? records[index + 1].index : lock.length;
      assert.match(lock.slice(start, end), /--hash=sha256:[a-f0-9]{64}/,
        `${records[index][1]} must have at least one artifact hash`);
    }
  });

  test(`${engine} source roots are represented in the lock`, () => {
    for (const line of source.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('--')) continue;
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(lock, new RegExp(`^${escaped}(?:\\s+\\\\)?\\s*$`, 'm'));
    }
  });

  if (docker) test(`${engine} Docker build cannot resolve an unlocked platform`, () => {
    assert.match(docker, /ARG TARGETOS/);
    assert.match(docker, /ARG TARGETARCH/);
    assert.match(docker, /test "\$TARGETOS" = linux/);
    assert.match(docker, /test "\$TARGETARCH" = amd64/);
    assert.match(docker, /pip install --require-hashes --only-binary=:all:/);
  });
}

test('MLX lock includes Chatterbox runtime imports', () => {
  const mlx = read('requirements-chatterbox-mlx.txt');
  const source = read('requirements-chatterbox-mlx.in');
  assert.match(source, /^einops==0\.8\.2$/m);
  assert.match(source, /^mlx-lm==0\.29\.1$/m);
  assert.match(source, /^scipy==1\.17\.1$/m);
  assert.match(mlx, /^einops==0\.8\.2\b/m);
  assert.match(mlx, /^mlx-lm==0\.29\.1\b/m);
  assert.match(mlx, /^scipy==1\.17\.1\b/m);
});

test('SBOM generation consumes every distributed lock directly', () => {
  const sbom = fs.readFileSync(path.join(root, 'scripts/release/generate-python-sboms.mjs'), 'utf8');
  assert.match(sbom, /\['kokoro', 'python\/requirements-kokoro\.txt'\]/);
  assert.match(sbom, /\['chatterbox', 'python\/requirements-chatterbox\.txt'\]/);
  assert.match(sbom, /\['kokoro-macos-arm64', 'python\/requirements-kokoro-macos-arm64\.txt'\]/);
  assert.match(sbom, /\['chatterbox-mlx', 'python\/requirements-chatterbox-mlx\.txt'\]/);
  assert.doesNotMatch(sbom, /\['kokoro', 'python\/constraints-kokoro\.txt'/);
  assert.doesNotMatch(sbom, /\['chatterbox', 'python\/constraints-chatterbox\.txt'/);
});

console.log(`${passed} passed, 0 failed`);
