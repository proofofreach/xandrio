#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');

const enabled = String(process.env.TAILSCALE_SERVE_AUTO || 'true').toLowerCase() !== 'false';
if (!enabled) process.exit(0);

const candidates = [
  process.env.TAILSCALE_BIN,
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  'tailscale'
].filter(Boolean);

function findTailscale() {
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const result = spawnSync('sh', ['-lc', `command -v ${candidate}`], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

const tailscale = findTailscale();
if (!tailscale) {
  console.warn('[tailscale-serve] Tailscale CLI not found; skipping HTTPS proxy setup.');
  process.exit(0);
}

const targetPort = process.env.TAILSCALE_SERVE_TARGET_PORT || process.env.PORT || '8181';
const httpsPort = process.env.TAILSCALE_SERVE_HTTPS_PORT || '443';
const target = process.env.TAILSCALE_SERVE_TARGET || `http://127.0.0.1:${targetPort}`;

const result = spawnSync(tailscale, ['serve', '--bg', `--https=${httpsPort}`, target], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

if (result.status !== 0) {
  console.warn(`[tailscale-serve] Failed to configure HTTPS proxy: ${result.stderr || result.stdout}`.trim());
  process.exit(0);
}

const status = spawnSync(tailscale, ['serve', 'status'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});

console.log(`[tailscale-serve] HTTPS proxy configured for ${target}`);
if (status.status === 0 && status.stdout.trim()) {
  console.log(status.stdout.trim());
}
