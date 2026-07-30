#!/usr/bin/env node
/**
 * Sync development commits to the public repository.
 *
 * Cherry-picks every commit on the source branch that is not yet on the
 * public target branch (by patch id), scrubs tool/AI attribution lines from
 * the commit messages, secret-scans the resulting branch with the pinned
 * Gitleaks wrapper, then pushes it, opens a PR, and arms auto-merge so it
 * lands once the required status checks pass.
 *
 * Only `main` may publish: features are proven on the trunk before they
 * reach the public repository (see docs/DEPLOYMENT_TOPOLOGY.md). Passing
 * a different --source requires the explicit --allow-source override.
 *
 * Usage:
 *   node scripts/release/sync-public.mjs [--source <branch>] [--remote public]
 *     [--target main] [--dry-run] [--no-merge] [--no-wait] [--allow-source]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const opt = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const REMOTE = opt('--remote', 'public');
const TARGET = opt('--target', 'main');
const DRY_RUN = has('--dry-run');
const NO_MERGE = has('--no-merge');
const NO_WAIT = has('--no-wait');
const PUBLIC_EXCLUDED_PATHS = new Set(['AGENTS.md']);

const git = (...a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const gh = (...a) => execFileSync('gh', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`sync-public error: ${message}`);
  process.exit(1);
}

const sleep = milliseconds => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

export function pullRequestState(source) {
  const parsed = JSON.parse(source);
  return {
    state: String(parsed.state || '').toUpperCase(),
    mergedAt: parsed.mergedAt || null,
    mergeCommit: parsed.mergeCommit?.oid || null
  };
}

export function canAutoResolvePublicExclusions(paths) {
  return paths.length > 0 && paths.every(filePath => PUBLIC_EXCLUDED_PATHS.has(filePath));
}

function waitForMergedPullRequest(prUrl, timeoutMs = 30 * 60 * 1000) {
  gh('pr', 'checks', prUrl, '--repo', 'ProofOfReach/xandrio', '--watch', '--interval', '10');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = pullRequestState(gh(
      'pr',
      'view',
      prUrl,
      '--repo',
      'ProofOfReach/xandrio',
      '--json',
      'state,mergedAt,mergeCommit'
    ));
    if (state.state === 'MERGED' && state.mergeCommit) return state;
    if (state.state === 'CLOSED') {
      throw new Error(`public release PR closed without merging: ${prUrl}`);
    }
    sleep(2000);
  }
  throw new Error(`timed out waiting for public release PR to merge: ${prUrl}`);
}

// Attribution lines that must never reach the public history: session
// trailers, co-author credits for AI tools, and generated-with banners.
const ATTRIBUTION_TRAILER = /^(claude-session|co-authored-by|generated[- ]with|generated[- ]by|coded[- ]by|assisted[- ]by)\b/i;
const ATTRIBUTION_CONTENT = /(claude\.ai\/code|noreply@anthropic\.com|anthropic\.com\/claude|🤖)/i;

export function scrubMessage(message) {
  const lines = String(message).split('\n').filter(line =>
    !ATTRIBUTION_TRAILER.test(line.trim()) && !ATTRIBUTION_CONTENT.test(line));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const scrubbed = lines.join('\n').trim();
  return scrubbed ? `${scrubbed}\n` : 'sync: publish development changes\n';
}

const startBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
const source = opt('--source', startBranch);

// Publishing bypassing the trunk is how the public repo once drifted ahead
// of main; only proven (merged-to-main) work may sync out.
if (source !== 'main' && !has('--allow-source')) {
  fail(`source branch is '${source}' but only 'main' may publish; ` +
    'merge to main first, or pass --allow-source for a deliberate exception');
}

if (git('status', '--porcelain')) fail('working tree is not clean; commit or stash first');
git('fetch', REMOTE, TARGET);

// The public history is periodically re-rooted (squashed), so patch-id
// comparison alone would resurrect ancient commits. The public-sync-base tag
// marks the last dev commit whose tree is already published; only commits
// after it are candidates.
let baseLimit = '';
try {
  baseLimit = git('rev-parse', '--verify', 'refs/tags/public-sync-base');
} catch {
  fail('missing public-sync-base tag; tag the last published dev commit first');
}

// '+ <sha>' lines are commits whose patch is absent from the target.
const pending = git('cherry', `${REMOTE}/${TARGET}`, source, baseLimit)
  .split('\n').filter(line => line.startsWith('+ ')).map(line => line.slice(2));
if (!pending.length) {
  console.log(`Nothing to sync: every ${source} patch is already on ${REMOTE}/${TARGET}.`);
  process.exit(0);
}
console.log(`Syncing ${pending.length} commit(s) from ${source} to ${REMOTE}/${TARGET}:`);
for (const sha of pending) console.log(`  ${git('log', '-1', '--format=%h %s', sha)}`);
if (DRY_RUN) process.exit(0);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const branch = `sync/${stamp}`;
git('checkout', '-b', branch, `${REMOTE}/${TARGET}`);

try {
  for (const sha of pending) {
    try {
      git('cherry-pick', '--allow-empty', sha);
    } catch (err) {
      const conflicts = git('diff', '--name-only', '--diff-filter=U')
        .split('\n').filter(Boolean);
      if (canAutoResolvePublicExclusions(conflicts)) {
        for (const filePath of conflicts) git('rm', '--ignore-unmatch', '--', filePath);
        git('cherry-pick', '--continue');
        console.log(`Preserved public exclusion for: ${conflicts.join(', ')}`);
      } else {
        git('cherry-pick', '--abort');
        throw new Error(`cherry-pick of ${sha.slice(0, 7)} conflicts with ${REMOTE}/${TARGET}; resolve manually (${err.message})`);
      }
    }
    git('commit', '--amend', '--no-edit', '-m', scrubMessage(git('log', '-1', '--format=%B', sha)));
  }

  // Secret-scan exactly what will be pushed: a single-branch clone whose
  // history is the public lineage plus the new commits.
  const scanDir = mkdtempSync(resolve(tmpdir(), 'xandrio-sync-scan-'));
  try {
    // The source repository contains the private-history public-sync-base tag.
    // Importing tags here makes the subsequent --all scan traverse history
    // that is not reachable from the public candidate.
    git('clone', '--quiet', '--single-branch', '--no-tags', '--branch', branch, REPO_ROOT, scanDir);
    execFileSync('node', [resolve(REPO_ROOT, 'scripts/release/scan-git-history.mjs'), '--repo', scanDir],
      { stdio: 'inherit' });
  } finally {
    rmSync(scanDir, { recursive: true, force: true });
  }

  const subject = git('log', '-1', '--format=%s', pending[pending.length - 1]);
  const body = ['Automated sync from the development branch.', '', 'Commits:',
    ...pending.map(sha => `- ${scrubMessage(git('log', '-1', '--format=%s', sha)).trim()}`)].join('\n');

  git('push', REMOTE, `${branch}:${branch}`);
  const prUrl = gh('pr', 'create', '--repo', 'ProofOfReach/xandrio',
    '--base', TARGET, '--head', branch, '--title', subject, '--body', body);
  console.log(`PR: ${prUrl}`);
  if (!NO_MERGE) {
    gh('pr', 'merge', '--repo', 'ProofOfReach/xandrio', '--auto', '--merge', prUrl);
    console.log('Auto-merge armed: the PR lands when required checks pass.');
  }
  if (!NO_MERGE && !NO_WAIT) {
    console.log('Waiting for every public release check and the protected merge...');
    const merged = waitForMergedPullRequest(prUrl);
    git('fetch', REMOTE, TARGET);
    git('tag', '-f', 'public-sync-base', source);
    console.log(`Public release merged at ${merged.mergeCommit}.`);
    console.log(`public-sync-base advanced to ${git('rev-parse', '--short', source)}.`);
  } else {
    console.log('public-sync-base was not advanced; deployment remains blocked until the PR merges.');
  }
} finally {
  git('checkout', startBranch);
  git('branch', '-D', branch);
}
