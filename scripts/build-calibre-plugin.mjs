import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'integrations', 'calibre-plugin');
const outputDir = path.join(root, 'public', 'downloads');
const output = path.join(outputDir, 'Xandrio-Calibre.zip');
const pluginFiles = [
  '__init__.py',
  'action.py',
  'config.py',
  'network.py',
  'README.md',
  'plugin-import-name-xandrio.txt'
];
const required = [...pluginFiles, 'LICENSE'];

for (const name of pluginFiles) {
  if (!fs.existsSync(path.join(source, name))) throw new Error(`Missing Calibre plugin file: ${name}`);
}
if (!fs.existsSync(path.join(root, 'LICENSE'))) throw new Error('Missing project LICENSE');
fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(output, { force: true });
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-calibre-plugin-'));
try {
  for (const name of pluginFiles) fs.copyFileSync(path.join(source, name), path.join(staging, name));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));
  const stableTime = new Date('1980-01-01T00:00:00.000Z');
  for (const name of required) fs.utimesSync(path.join(staging, name), stableTime, stableTime);
  execFileSync('zip', ['-X', '-q', output, ...required], { cwd: staging });
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
console.log(`Built ${path.relative(root, output)}`);
