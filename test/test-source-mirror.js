#!/usr/bin/env node
/**
 * The source mirror gate: a release must not publish a revision whose only
 * other copy is the working checkout.
 */
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

let passed = 0;
let failed = 0;

async function check(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

// A stand-in for git that answers from a declared ancestry instead of a repo.
function fakeGit({ head, mirror, ancestors = {}, fetchFails = false }) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args.join(' '));
      const [command] = args;
      if (command === 'fetch') {
        if (fetchFails) throw new Error('network unreachable');
        return '';
      }
      if (command === 'rev-parse') return args[1] === 'HEAD' ? head : mirror;
      if (command === 'rev-list') return '17';
      if (command === 'merge-base') {
        const [, , ancestor, descendant] = args;
        if ((ancestors[ancestor] || []).includes(descendant)) return '';
        throw new Error('not an ancestor');
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    }
  };
}

(async () => {
  const { checkSourceMirror } = await import(pathToFileURL(resolve(
    __dirname, '..', 'scripts', 'release', 'check-source-mirror.mjs'
  )));

  await check('a mirror holding this revision releases', () => {
    const git = fakeGit({ head: 'abc', mirror: 'abc' });
    const result = checkSourceMirror({ run: git.run });
    assert.equal(result.state, 'current');
    assert(git.calls.some(call => call.startsWith('fetch')), 'it must re-read the remote, not trust a stale ref');
  });

  await check('a mirror behind this revision refuses, and says how far', () => {
    const git = fakeGit({ head: 'new', mirror: 'old', ancestors: { old: ['new'] } });
    assert.throws(() => checkSourceMirror({ run: git.run }), /17 commit\(s\) behind/);
  });

  await check('the refusal names the push that fixes it', () => {
    const git = fakeGit({ head: 'new', mirror: 'old', ancestors: { old: ['new'] } });
    assert.throws(() => checkSourceMirror({ run: git.run }), /git push origin main/);
  });

  await check('a mirror ahead of this checkout refuses rather than ship the older revision', () => {
    const git = fakeGit({ head: 'old', mirror: 'new', ancestors: { old: ['new'] } });
    assert.throws(() => checkSourceMirror({ run: git.run }), /ahead of this checkout/);
  });

  await check('a diverged mirror refuses', () => {
    const git = fakeGit({ head: 'mine', mirror: 'theirs' });
    assert.throws(() => checkSourceMirror({ run: git.run }), /diverged/);
  });

  await check('an unreachable mirror refuses rather than assume it is current', () => {
    const git = fakeGit({ head: 'abc', mirror: 'abc', fetchFails: true });
    assert.throws(() => checkSourceMirror({ run: git.run }), /cannot reach the source mirror/);
  });

  await check('the remote and branch are configurable', () => {
    const git = fakeGit({ head: 'new', mirror: 'old', ancestors: { old: ['new'] } });
    assert.throws(
      () => checkSourceMirror({ run: git.run, remote: 'backup', branch: 'trunk' }),
      /git push backup trunk/
    );
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
