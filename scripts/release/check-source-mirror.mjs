#!/usr/bin/env node
/**
 * Refuse to release while the private source mirror does not hold the revision
 * being released.
 *
 * A release publishes through the sanitized public repository, so nothing in
 * the pipeline ever reads or writes the private remote. That is exactly why the
 * mirror can fall behind without anyone noticing: every release succeeds, every
 * receipt is truthful, and the only copy of the revision that produced them is
 * the working checkout. This ran seventeen commits behind before it was caught
 * by hand.
 *
 * Fails closed. A mirror that cannot be reached is not a mirror that is known
 * to be current.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  throw error;
}

export function checkSourceMirror({
  remote = process.env.XANDRIO_SOURCE_REMOTE || 'origin',
  branch = process.env.XANDRIO_SOURCE_BRANCH || 'main',
  // The gate always asks about this checkout, whatever directory it was
  // invoked from; tests point it at a scratch repository instead.
  cwd = REPO_ROOT,
  run = (args) => git(args, { cwd })
} = {}) {
  const head = run(['rev-parse', 'HEAD']);

  try {
    run(['fetch', '--quiet', remote, branch]);
  } catch (error) {
    fail(
      `cannot reach the source mirror '${remote}' to confirm it holds this revision: ${error.message}`
    );
  }

  const mirror = run(['rev-parse', 'FETCH_HEAD']);
  if (mirror === head) return { head, mirror, state: 'current' };

  // `merge-base --is-ancestor` exits non-zero to say "no", so ask it as a
  // question rather than letting a plain "no" look like a git failure.
  const contains = (ancestor, descendant) => {
    try {
      run(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };

  if (contains(mirror, head)) {
    const missing = run(['rev-list', '--count', `${mirror}..${head}`]);
    fail(
      `the source mirror '${remote}/${branch}' is ${missing} commit(s) behind this revision. ` +
      `A release would publish work whose only other copy is this checkout. ` +
      `Push it first: git push ${remote} ${branch}`
    );
  }

  if (contains(head, mirror)) {
    fail(
      `the source mirror '${remote}/${branch}' is ahead of this checkout. ` +
      `Releasing would ship an older revision than the one on record. ` +
      `Reconcile first: git pull --ff-only ${remote} ${branch}`
    );
  }

  fail(
    `this checkout and the source mirror '${remote}/${branch}' have diverged. ` +
    `Reconcile them before releasing.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const { head } = checkSourceMirror();
    console.log(`Source mirror holds ${head.slice(0, 10)}.`);
  } catch (error) {
    console.error(`source-mirror error: ${error.message}`);
    process.exitCode = 1;
  }
}
