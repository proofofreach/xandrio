#!/usr/bin/env node
/** Generate the Node dependency inventory from an installed, locked tree. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const rows = [];

for (const [location, entry] of Object.entries(lock.packages || {})) {
  if (!location.startsWith('node_modules/') || !entry.version) continue;
  const manifest = resolve(root, location, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const license = typeof pkg.license === 'string'
    ? pkg.license
    : Array.isArray(pkg.licenses) ? pkg.licenses.map(item => item.type || item).join(' OR ') : 'UNKNOWN';
  rows.push({ name: pkg.name || location.slice('node_modules/'.length), version: entry.version, license, repository: pkg.repository });
}

rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const table = rows.map(({ name, version, license, repository }) => {
  const source = typeof repository === 'string' ? repository : repository?.url || '';
  return `| ${name} | ${version} | ${license} | ${source.replace(/^git\+/, '')} |`;
}).join('\n');

const manual = `## Bundled and optional assets\n\n| Component | Source / licence status |\n| --- | --- |\n| Inter font (\`public/fonts/inter-latin.woff2\`) | Google Fonts Inter v20 Latin variable subset, SIL Open Font License 1.1. Exact source and hash are in \`public/fonts/README.md\`; the required notice is bundled in \`public/fonts/OFL.txt\`. |\n| Application and Umbrel icons | Project-owned Xandrio artwork; the project owner approved public distribution, including Umbrel-specific use, on 2026-07-15. |\n| Embedded TTS comparison pages | The project owner approved public distribution of the embedded comparison assets on 2026-07-15. |\n| Kokoro 0.9.4 and Misaki 0.9.4 | Apache-2.0. Pinned in python/requirements-kokoro.txt; model-card and model-weight terms must be reviewed before shipping weights. Xandrio does not bundle model weights. |\n| PyTorch 2.12.0 / 2.6.0 and torchaudio 2.6.0 | BSD-3-Clause (PyTorch); pinned in the hash-checked Linux locks. |\n| Chatterbox 0.1.7 and Resemble Perth 1.0.1 | MIT. Pinned in python/requirements-chatterbox.txt; model-card and model-weight terms must be reviewed before shipping weights. Xandrio does not bundle model weights. |\n| MLX-Audio 0.2.9 and MLX 0.31.2 | MIT. Pinned in python/requirements-chatterbox-mlx.txt. |\n| Edge TTS | Remote integration; no Microsoft binaries or voices are bundled. See product documentation for service terms and data flow. |\n| OCR, Poppler, ffmpeg, Playwright/Chromium, and base image | Installed by the container distribution. Container SBOM and image scan are generated for every release; retain their upstream notices with distributed images. |\n\nUser books, covers, credentials, generated audio, voice references, local screenshots, and test output are operator data and must not be bundled. Existing tracked standalone benchmark/reference audio is separately identified as the remaining asset release blocker in docs/ASSET_PROVENANCE.md; it is not implicitly licensed by this notice.\n`;

const output = `# Third-party notices\n\nThis file is generated from the locked installed Node dependency tree by \`npm run notices\`. Regenerate it after every lockfile change in a clean \`npm ci\` environment. Entries marked \`UNKNOWN\` require a release review; do not publish an artifact until they are resolved or accepted by the project owner.\n\n## Node production and development dependencies\n\n| Package | Version | Declared licence | Source |\n| --- | --- | --- | --- |\n${table || '| No installed packages found | | | |'}\n\n${manual}`;
writeFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), output);
console.log(`Wrote THIRD_PARTY_NOTICES.md with ${rows.length} locked packages.`);
