#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { finished } from 'node:stream/promises';

const root = process.argv[2] || process.cwd();
const shotsRoot = join(root, 'artifacts', 'scenario-shots');
const startedAt = Date.now();
const views = 'library,search,settings,stats,guide,player,activity,login';

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function run() {
  const scenarioShotsScript = process.env.SCENARIO_SHOTS_SCRIPT || 'scripts/scenario-shots.js';
  const child = spawn(process.execPath, [scenarioShotsScript, '--port=0', `--views=${views}`], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await Promise.all([finished(child.stdout), finished(child.stderr)]);
  return { ...(await exit), stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

async function pngFiles(dir) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.png')) files.push(path);
    }
  }
  await walk(dir);
  return files;
}

const semanticGroups = {
  library: ['cold', 'empty', 'loading', 'error', 'offline', 'degraded', 'full'],
  search: ['empty', 'loading', 'error', 'full'],
  settings: ['loading', 'error', 'degraded', 'full'],
  stats: ['empty', 'loading', 'error', 'full'],
  guide: ['loading', 'error', 'full'],
  player: ['loading', 'error', 'degraded', 'full'],
  login: ['error', 'offline', 'full']
};

// These are sheet-level cells, not merely the player shell captured after an
// incidental click. scenario-shots.js refuses to write each PNG unless its
// state-bearing selector is fully contained in the capture viewport.
const overlayGroups = {
  player: ['chapters', 'bookmarks', 'voice', 'voice-degraded', 'speed', 'sleep', 'pronunciation'],
  activity: ['active']
};
const overlayVariants = [
  'mobile_dark_nopreference_normal.png',
  'desktop_dark_nopreference_normal.png'
];

function emit(status, evidence) {
  process.stdout.write(`${JSON.stringify({ status, evidence })}\n`);
  // Loopy consumes this exact JSON envelope from stdout. Set the shell result
  // separately so an actionable critic finding also fails normal CLI/CI gates.
  if (status === 'actionable') process.exitCode = 1;
}

try {
  const execution = await run();
  const failures = [];
  if (execution.code !== 0) {
    failures.push(`scenario-shots exited ${execution.code ?? execution.signal}: ${execution.stderr.slice(-1000)}`);
  }

  const files = await pngFiles(shotsRoot);
  const fresh = [];
  for (const file of files) {
    const metadata = await stat(file);
    if (metadata.mtimeMs >= startedAt - 1000) fresh.push(file);
  }
  const freshSet = new Set(fresh);
  // The normal sample sweep adds desktop primary captures for settings'
  // loading/error/degraded surfaces, where opening the Voice accordion is
  // necessary to expose the real state-bearing UI.
  if (fresh.length !== 90) failures.push(`expected 90 freshly rendered screenshots, found ${fresh.length}`);

  for (const [view, states] of Object.entries(semanticGroups)) {
    const seen = new Map();
    for (const state of states) {
      const file = join(shotsRoot, view, state, 'mobile_dark_nopreference_normal.png');
      if (!freshSet.has(file)) {
        failures.push(`missing freshly rendered state screenshot: ${relative(root, file)}`);
        continue;
      }
      let digest;
      try {
        digest = hash(await readFile(file));
      } catch {
        failures.push(`missing required state screenshot: ${relative(root, file)}`);
        continue;
      }
      const prior = seen.get(digest);
      if (prior) failures.push(`${view}:${state} is byte-identical to ${view}:${prior}`);
      else seen.set(digest, state);
    }
  }

  for (const [view, states] of Object.entries(overlayGroups)) {
    for (const state of states) {
      for (const variant of overlayVariants) {
        const file = join(shotsRoot, view, state, variant);
        if (!freshSet.has(file)) {
          failures.push(`missing freshly rendered overlay screenshot: ${relative(root, file)}`);
        }
      }
    }
  }

  const freshScreenshots = [];
  for (const file of fresh) {
    const screenshotPath = relative(root, file);
    try {
      freshScreenshots.push({
        path: screenshotPath,
        sha256: hash(await readFile(file))
      });
    } catch (error) {
      failures.push(`unable to fingerprint freshly rendered screenshot: ${screenshotPath}`);
      freshScreenshots.push({ path: screenshotPath, sha256: null });
    }
  }
  freshScreenshots.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });

  const fingerprint = hash(Buffer.from(JSON.stringify({
    code: execution.code,
    fresh: freshScreenshots,
    failures
  })));
  emit(failures.length ? 'actionable' : 'complete', {
    fingerprint,
    screenshots: fresh.length,
    failures,
    stdout_sha256: hash(Buffer.from(execution.stdout)),
    stderr_sha256: hash(Buffer.from(execution.stderr))
  });
} catch (error) {
  emit('actionable', {
    fingerprint: hash(Buffer.from(error.stack || error.message)),
    screenshots: 0,
    failures: [error.stack || error.message]
  });
}
