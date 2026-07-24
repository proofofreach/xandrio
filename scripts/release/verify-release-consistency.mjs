#!/usr/bin/env node
/**
 * Reject a release when the source-controlled version declarations drift.
 * Image digests are deliberately supplied only after the multi-architecture
 * candidate has been tested; see render-umbrel-release.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const tag = option('--tag');
const digest = option('--digest');

function readJson(file) {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function fail(message) {
  console.error(`release consistency error: ${message}`);
  process.exitCode = 1;
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const expectedVersion = packageJson.version;
const expectedTag = `v${expectedVersion}`;
const umbrel = readFileSync(resolve(root, 'alexandrio-xandrio/umbrel-app.yml'), 'utf8');
const compose = readFileSync(resolve(root, 'alexandrio-xandrio/docker-compose.yml'), 'utf8');
const umbrelReadme = readFileSync(resolve(root, 'alexandrio-xandrio/README.md'), 'utf8');
const rootCompose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
const localEngineCompose = readFileSync(resolve(root, 'docker-compose.local-engines.yml'), 'utf8');
const changelog = readFileSync(resolve(root, 'docs/CHANGELOG.md'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'public/sw.js'), 'utf8');
const webManifest = readJson('public/manifest.webmanifest');

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  fail(`package.json version is not a release semver: ${expectedVersion}`);
}
if (packageLock.version !== expectedVersion || packageLock.packages?.['']?.version !== expectedVersion) {
  fail('package-lock.json root version does not match package.json');
}
if (!new RegExp(`^version: ["']${expectedVersion}["']$`, 'm').test(umbrel)) {
  fail('alexandrio-xandrio/umbrel-app.yml version does not match package.json');
}
if (!compose.includes(`XANDRIO_IMAGE_TAG:-${expectedVersion}`)) {
  fail('Umbrel Compose template default image tag does not match package.json');
}
if (!compose.includes('XANDRIO_IMAGE_DIGEST:?Set the tested multi-architecture image digest')) {
  fail('Umbrel Compose template must require a tested image digest');
}
if (!umbrelReadme.includes(`--tag v${expectedVersion}`) || umbrelReadme.includes('alexandrio:1.0.0')) {
  fail('Umbrel release instructions do not match package.json');
}
if (!rootCompose.includes(`XANDRIO_VERSION:-${expectedVersion}`)) {
  fail('root Docker Compose default version does not match package.json');
}
if (!localEngineCompose.includes(`XANDRIO_VERSION:-${expectedVersion}`)) {
  fail('local-engine Docker Compose default version does not match package.json');
}
if (!new RegExp(`^## \\[${expectedVersion.replace(/\./g, '\\.') }\\]`, 'm').test(changelog) || !/^## \[Unreleased\]/m.test(changelog)) {
  fail('changelog must contain [Unreleased] and the package release version');
}
if (!serviceWorker.includes(`const APP_RELEASE = '${expectedVersion}';`)) {
  fail('service-worker application release does not match package.json');
}
if (webManifest.version !== expectedVersion) {
  fail('web manifest version does not match package.json');
}
if (tag && tag !== expectedTag) {
  fail(`tag ${tag} does not match ${expectedTag}`);
}
if (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
  fail(`invalid OCI digest: ${digest}`);
}

if (!process.exitCode) {
  console.log(`Release declarations are consistent for ${expectedTag}${digest ? ` (${digest})` : ''}.`);
}
