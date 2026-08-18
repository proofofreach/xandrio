/**
 * Transient-failure handling for the GitHub calls a release depends on.
 *
 * A release is expensive to reach: the suite, the browser smoke, the import
 * benchmark and a full-history secret scan all run before the first API call.
 * GitHub answering 503 for a minute used to throw that away and leave a pushed
 * branch with no pull request behind. These helpers retry only what is worth
 * retrying -- transport failures -- and never a real answer such as a failing
 * check or a rejected merge.
 *
 * Kept free of side effects at import time so it can be tested directly.
 */

const TRANSIENT =
  /HTTP\s+50[0234]\b|status code:\s*50[0234]\b|service unavailable|bad gateway|gateway time-?out|no server is currently available|connection reset|EAI_AGAIN/i;

export function isTransientGitHubFailure(error) {
  return TRANSIENT.test(String(error?.stderr || error?.message || ''));
}

export function retryBackoffMs(attempt) {
  return Math.min(30000, 2000 * 2 ** (attempt - 1));
}

// `gh pr list --json url,state` for a head branch: the PR may already exist
// because a previous attempt opened it and then lost the response.
export function openPullRequestUrl(listJson) {
  const parsed = JSON.parse(listJson || '[]');
  const open = parsed.find(entry => String(entry.state || '').toUpperCase() === 'OPEN');
  return open?.url || null;
}

export function withGitHubRetry(run, { attempts = 6, sleep, log = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return run(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransientGitHubFailure(error)) throw error;
      const wait = retryBackoffMs(attempt);
      log(`GitHub is unavailable (attempt ${attempt}/${attempts}); retrying in ${Math.round(wait / 1000)}s...`);
      sleep?.(wait);
    }
  }
}
