#!/usr/bin/env node
/** Render a digest-pinned Umbrel bundle from the verified release candidate. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const tag = option('--tag');
const digest = option('--digest');
const output = option('--output-dir') || resolve(root, 'release', 'umbrel');
const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

if (tag !== `v${packageVersion}`) throw new Error(`Expected --tag v${packageVersion}`);
if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Expected a sha256 image digest');

const check = spawnSync('node', ['scripts/release/verify-release-consistency.mjs', '--tag', tag, '--digest', digest], {
  cwd: root,
  stdio: 'inherit'
});
if (check.status !== 0) process.exit(check.status || 1);

const sourceDir = resolve(root, 'alexandrio-xandrio');
const compose = readFileSync(resolve(sourceDir, 'docker-compose.yml'), 'utf8')
  .replaceAll(`\${XANDRIO_IMAGE_TAG:-${packageVersion}}`, packageVersion)
  .replaceAll('${XANDRIO_IMAGE_DIGEST:?Set the tested multi-architecture image digest}', digest);
if (compose.includes('${XANDRIO_IMAGE_')) throw new Error('Failed to render a fully pinned Umbrel image reference');

mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'docker-compose.yml'), compose);
writeFileSync(resolve(output, 'umbrel-app.yml'), readFileSync(resolve(sourceDir, 'umbrel-app.yml')));
copyFileSync(resolve(sourceDir, 'icon.png'), resolve(output, 'icon.png'));
copyFileSync(resolve(sourceDir, 'README.md'), resolve(output, 'README.md'));
console.log(`Rendered digest-pinned Umbrel bundle in ${output}`);
