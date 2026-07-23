#!/usr/bin/env node
/** Fail release publication when GitHub repository controls are not enforced. */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const repository = option('--repo') || process.env.GITHUB_REPOSITORY;

function fail(message) {
  console.error(`public repository control error: ${message}`);
  process.exit(1);
}

function api(endpoint) {
  const result = spawnSync('gh', [
    'api',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    endpoint
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`GitHub API request failed: ${endpoint}`);
  }
  return JSON.parse(result.stdout);
}

if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  fail('pass --repo OWNER/REPOSITORY or set GITHUB_REPOSITORY');
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  fail('GH_TOKEN or GITHUB_TOKEN is required');
}

try {
  const metadata = api(`repos/${repository}`);
  if (metadata.visibility !== 'public' || metadata.private !== false) {
    throw new Error('the release repository is not public');
  }
  if (metadata.default_branch !== 'main') {
    throw new Error(`the default branch is ${metadata.default_branch || 'unset'}, not main`);
  }

  const protection = api(`repos/${repository}/branches/main/protection`);
  if (!protection.enforce_admins?.enabled) throw new Error('main protection does not enforce rules for administrators');
  if (!protection.required_status_checks?.strict) throw new Error('main does not require an up-to-date branch before merge');
  const statusContexts = new Set([
    ...(protection.required_status_checks?.contexts || []),
    ...(protection.required_status_checks?.checks || []).map(check => check.context)
  ]);
  for (const context of ['verify', 'dependency-review']) {
    if (!statusContexts.has(context)) throw new Error(`main does not require the ${context} status check`);
  }

  const reviews = protection.required_pull_request_reviews;
  if (!reviews || reviews.required_approving_review_count < 1) throw new Error('main does not require an approving review');
  if (!reviews.dismiss_stale_reviews) throw new Error('main does not dismiss stale approvals');
  if (!reviews.require_code_owner_reviews) throw new Error('main does not require CODEOWNER review');
  if (!protection.required_conversation_resolution?.enabled) throw new Error('main does not require conversation resolution');
  if (protection.allow_force_pushes?.enabled) throw new Error('main permits force pushes');
  if (protection.allow_deletions?.enabled) throw new Error('main permits deletion');

  const environment = api(`repos/${repository}/environments/release`);
  const reviewerRule = environment.protection_rules?.find(rule => rule.type === 'required_reviewers');
  if (!reviewerRule?.reviewers?.length) throw new Error('the release environment has no required reviewer');
  if (!reviewerRule.prevent_self_review) throw new Error('the release environment permits self-review');

  const workflowPermissions = api(`repos/${repository}/actions/permissions/workflow`);
  if (workflowPermissions.default_workflow_permissions !== 'read') {
    throw new Error('default GitHub Actions workflow permissions are not read-only');
  }
  if (workflowPermissions.can_approve_pull_request_reviews) {
    throw new Error('GitHub Actions may approve pull requests');
  }

  console.log(`Public repository controls passed for ${repository}.`);
} catch (error) {
  fail(error.message);
}
