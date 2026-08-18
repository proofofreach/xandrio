#!/usr/bin/env node
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

let passed = 0;
let failed = 0;

function check(name, callback) {
  return Promise.resolve()
    .then(callback)
    .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
    .catch(error => { failed += 1; console.error(`  ✗ ${name}: ${error.message}`); });
}

// The two failures that actually stopped a release, verbatim.
const OUTAGE_503 =
  'HTTP 503: No server is currently available to service your request. Sorry about that. (https://api.github.com/graphql)';
const OUTAGE_NON200 =
  'non-200 OK status code: 503 Service Unavailable body: "{\\"message\\": \\"No server is currently available\\"}"';

(async () => {
  const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', 'scripts', 'release', 'github-retry.mjs')
  );
  const { isTransientGitHubFailure, retryBackoffMs, openPullRequestUrl, withGitHubRetry } =
    await import(moduleUrl.href);

  await check('the outage messages that stopped this release are transient', () => {
    assert.equal(isTransientGitHubFailure(new Error(OUTAGE_503)), true);
    assert.equal(isTransientGitHubFailure(new Error(OUTAGE_NON200)), true);
    assert.equal(isTransientGitHubFailure({ stderr: OUTAGE_NON200 }), true);
    assert.equal(isTransientGitHubFailure(new Error('502 Bad Gateway')), true);
    assert.equal(isTransientGitHubFailure(new Error('getaddrinfo EAI_AGAIN api.github.com')), true);
  });

  await check('a real answer is never retried', () => {
    // Retrying these would turn a decided outcome into a hang or a duplicate.
    assert.equal(isTransientGitHubFailure(new Error('pull request review required')), false);
    assert.equal(isTransientGitHubFailure(new Error('HTTP 404: Not Found')), false);
    assert.equal(isTransientGitHubFailure(new Error('HTTP 422: Validation Failed')), false);
    assert.equal(isTransientGitHubFailure(new Error('a pull request already exists for sync/1')), false);
    assert.equal(isTransientGitHubFailure(new Error('checks failed: verify')), false);
    assert.equal(isTransientGitHubFailure(null), false);
  });

  await check('a commit subject mentioning 503 is not mistaken for an outage', () => {
    assert.equal(isTransientGitHubFailure(new Error('Fix 503 handling in the reader')), false);
  });

  await check('a transient failure is retried until it succeeds', () => {
    const waits = [];
    let calls = 0;
    const result = withGitHubRetry(() => {
      calls += 1;
      if (calls < 3) throw new Error(OUTAGE_503);
      return 'https://github.com/x/y/pull/1';
    }, { attempts: 6, sleep: ms => waits.push(ms) });
    assert.equal(result, 'https://github.com/x/y/pull/1');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 4000]);
  });

  await check('retries are bounded and the last failure is surfaced', () => {
    let calls = 0;
    assert.throws(() => withGitHubRetry(() => {
      calls += 1;
      throw new Error(OUTAGE_503);
    }, { attempts: 3, sleep: () => {} }), /No server is currently available/);
    assert.equal(calls, 3);
  });

  await check('a non-transient failure fails on the first attempt', () => {
    let calls = 0;
    assert.throws(() => withGitHubRetry(() => {
      calls += 1;
      throw new Error('HTTP 422: Validation Failed');
    }, { attempts: 6, sleep: () => {} }), /Validation Failed/);
    assert.equal(calls, 1, 'a decided failure must not be retried');
  });

  await check('backoff grows and stays bounded', () => {
    assert.equal(retryBackoffMs(1), 2000);
    assert.equal(retryBackoffMs(2), 4000);
    assert.ok(retryBackoffMs(10) <= 30000, 'backoff is capped');
  });

  await check('an already-open pull request is found rather than recreated', () => {
    const listed = JSON.stringify([{ url: 'https://github.com/x/y/pull/137', state: 'OPEN' }]);
    assert.equal(openPullRequestUrl(listed), 'https://github.com/x/y/pull/137');
  });

  await check('closed or merged pull requests never count as reusable', () => {
    // Reusing a merged PR would report success without publishing anything.
    assert.equal(openPullRequestUrl(JSON.stringify([{ url: 'u', state: 'MERGED' }])), null);
    assert.equal(openPullRequestUrl(JSON.stringify([{ url: 'u', state: 'CLOSED' }])), null);
    assert.equal(openPullRequestUrl('[]'), null);
    assert.equal(openPullRequestUrl(''), null);
  });

  await check('a create that landed despite a transport error is adopted, not duplicated', () => {
    // Exactly the attempt-4 shape: the PR exists, the response was lost.
    let created = 0;
    let listCalls = 0;
    const url = withGitHubRetry(() => {
      const existing = listCalls++ === 0 ? '[]' : JSON.stringify([{ url: 'https://p/137', state: 'OPEN' }]);
      const open = openPullRequestUrl(existing);
      if (open) return open;
      created += 1;
      throw new Error(OUTAGE_NON200);
    }, { attempts: 6, sleep: () => {} });
    assert.equal(url, 'https://p/137');
    assert.equal(created, 1, 'the pull request must only ever be created once');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
