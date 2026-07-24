#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const outputDir = resolve(root, 'artifacts');
const command = process.env.CYCLONEDX_PYTHON || 'cyclonedx-py';
const engines = [
  ['kokoro', 'python/requirements-kokoro.txt'],
  ['chatterbox', 'python/requirements-chatterbox.txt'],
  ['kokoro-macos-arm64', 'python/requirements-kokoro-macos-arm64.txt'],
  ['chatterbox-mlx', 'python/requirements-chatterbox-mlx.txt']
];

function dependencyLines(...files) {
  return files.flatMap(file => {
  return readFileSync(resolve(root, file), 'utf8')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:-c|--(?:index|extra-index)-url)\b/.test(line));
  }).join('\n');
}

mkdirSync(outputDir, { recursive: true });
for (const [engine, ...requirementFiles] of engines) {
  const input = `${dependencyLines(...requirementFiles)}\n`;
  // This is a source-level inventory, not an installed-image SBOM. The image
  // workflow separately freezes each built environment, including transitives.
  const output = resolve(outputDir, `xandrio-${engine}-declared.cdx.json`);
  const result = spawnSync(command, [
    'requirements', '-',
    '--output-reproducible',
    '--spec-version', '1.6',
    '--output-format', 'JSON',
    '--output-file', output
  ], { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`Wrote ${output}`);
}
