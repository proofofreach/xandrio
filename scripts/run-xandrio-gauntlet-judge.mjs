#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { finished } from 'node:stream/promises';

const root = resolve(process.argv[2] || '.');
const reportPath = resolve(root, process.argv[3] || 'artifacts/gauntlet/progress.md');
const profile = process.env.XANDRIO_GAUNTLET_PROFILE || 'core';
const timeoutMs = Number(process.env.XANDRIO_GAUNTLET_GATE_TIMEOUT_MS || 30 * 60 * 1000);
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const evidenceDir = resolve(root, 'logs', 'gauntlet', runId);

if (isAbsolute(process.argv[3] || '') || relative(root, reportPath).startsWith('..')) {
  throw new Error('The Gauntlet report path must remain inside the repository');
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  throw new Error('XANDRIO_GAUNTLET_GATE_TIMEOUT_MS must be at least 1000');
}

const coreGates = [
  { id: 'diff-check', command: 'git', args: ['diff', '--check'], scope: '.' },
  { id: 'unit-regression', command: 'npm', args: ['test'], scope: 'test/**, lib/**, server.js, public/**' },
  { id: 'browser-pwa', command: 'npm', args: ['run', 'test:browser'], scope: 'public/**, scripts/smoke-browser.js' },
  { id: 'audio-policy', command: 'npm', args: ['run', 'verify:audio:ci'], scope: 'lib/**, scripts/verify-audio-quality.js' },
  { id: 'playback-performance', command: 'npm', args: ['run', 'benchmark:mobile-playback'], scope: 'public/app.js, public/js/**, lib/routes/playback-routes.js' },
  { id: 'android-lockscreen', command: 'npm', args: ['run', 'verify:android-lockscreen'], scope: 'public/app.js, public/js/single-file-chapter-player.js, scripts/verify-android-lockscreen.js' },
  { id: 'player-layout', command: 'node', args: ['scripts/measure-player-layout.js'], scope: 'public/index.html, public/style-v3.css, public/js/views/player-ui.js' },
  { id: 'release-audit', command: 'npm', args: ['run', 'audit:release'], scope: 'package.json, package-lock.json' },
  { id: 'docker-context', command: 'npm', args: ['run', 'check:docker-context'], scope: '.dockerignore, scripts/release/check-docker-context.mjs' }
];
const fastIds = new Set(['diff-check', 'browser-pwa', 'player-layout']);
const gates = profile === 'fast' ? coreGates.filter(gate => fastIds.has(gate.id)) : coreGates;

function hashFile(path) {
  return readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'));
}

function runGate(gate) {
  return new Promise(resolveGate => {
    const startedAt = Date.now();
    const stdoutPath = resolve(evidenceDir, `${gate.id}.stdout.log`);
    const stderrPath = resolve(evidenceDir, `${gate.id}.stderr.log`);
    const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
    const stderr = createWriteStream(stderrPath, { flags: 'wx' });
    const child = spawn(gate.command, gate.args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once('error', error => stderr.write(`${error.stack || error.message}\n`));
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      await Promise.all([finished(stdout), finished(stderr)]);
      const [stdoutSha256, stderrSha256] = await Promise.all([hashFile(stdoutPath), hashFile(stderrPath)]);
      resolveGate({
        ...gate,
        status: code === 0 && !timedOut ? 'passed' : 'failed',
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutPath: relative(root, stdoutPath),
        stderrPath: relative(root, stderrPath),
        stdoutSha256,
        stderrSha256
      });
    });
  });
}

function progressSection(receipt) {
  const rows = receipt.gates.map(gate =>
    `| ${gate.id} | ${gate.status} | ${(gate.durationMs / 1000).toFixed(1)}s | \`${gate.stdoutSha256.slice(0, 12)}\` |`
  ).join('\n');
  return `<!-- GAUNTLET_EXTERNAL_START -->
## Latest external gate receipt

- Run: \`${receipt.runId}\`
- Commit: \`${receipt.commit}\`
- Profile: \`${receipt.profile}\`
- Result: **${receipt.passed ? 'passed' : 'actionable'}**
- Environment: Node ${receipt.environment.node} on ${receipt.environment.platform}
- Private evidence: \`${relative(root, evidenceDir)}\`

| Gate | Status | Duration | stdout SHA-256 |
|---|---:|---:|---|
${rows}

Limitations: ${receipt.limitations.join(' ')}
<!-- GAUNTLET_EXTERNAL_END -->`;
}

async function updateProgress(receipt) {
  const start = '<!-- GAUNTLET_EXTERNAL_START -->';
  const end = '<!-- GAUNTLET_EXTERNAL_END -->';
  const section = progressSection(receipt);
  let current = '';
  try { current = await readFile(reportPath, 'utf8'); } catch {}
  const startAt = current.indexOf(start);
  const endAt = current.indexOf(end);
  const next = startAt >= 0 && endAt > startAt
    ? `${current.slice(0, startAt)}${section}${current.slice(endAt + end.length)}`
    : `${current.trim()}\n\n${section}\n`;
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, next, 'utf8');
}

await mkdir(evidenceDir, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
for (const gate of gates) results.push(await runGate(gate));
const finishedAt = new Date().toISOString();
const commitResult = await new Promise(resolveCommit => {
  const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  let value = '';
  child.stdout.on('data', chunk => { value += chunk; });
  child.once('close', () => resolveCommit(value.trim() || 'unknown'));
});
const failed = results.filter(gate => gate.status !== 'passed');
const fingerprint = createHash('sha256')
  .update(results.map(gate => `${gate.id}:${gate.status}:${gate.stdoutSha256}:${gate.stderrSha256}`).join('|'))
  .digest('hex');
const receipt = {
  schemaVersion: 1,
  runId,
  commit: commitResult,
  profile,
  startedAt,
  finishedAt,
  environment: { node: process.version, platform: process.platform, artifact: 'local-server+synthetic-fixtures' },
  gates: results.map(({ command, args, scope, ...gate }) => ({ ...gate, command: [command, ...args].join(' '), scope })),
  passed: failed.length === 0,
  warnings: process.versions.node.split('.')[0] === '24' ? [] : [`Validated under ${process.version}; Xandrio production requires Node 24.`],
  limitations: [
    'Executable gates do not establish subjective reference-product parity.',
    'Chromium browser smoke is not a physical iOS/PWA test.',
    'A comprehensive automated WCAG tree audit is not yet present.'
  ],
  fingerprint
};
await writeFile(resolve(evidenceDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
await updateProgress(receipt);

const workstreams = failed.map(gate => ({ id: `gate-${gate.id}`, title: `Repair ${gate.id}`, scope: gate.scope }));
process.stdout.write(`${JSON.stringify({
  status: receipt.passed ? 'complete' : 'actionable',
  evidence: {
    fingerprint,
    receiptPath: relative(root, resolve(evidenceDir, 'receipt.json')),
    workstreams,
    failedGates: failed.map(gate => gate.id),
    warnings: receipt.warnings,
    limitations: receipt.limitations
  }
})}\n`);
