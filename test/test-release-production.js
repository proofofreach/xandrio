#!/usr/bin/env node
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

(async () => {
  const release = await import(pathToFileURL(resolve(
    __dirname,
    '..',
    'scripts',
    'release',
    'release-production.mjs'
  )));

  await check('one release interface publishes before deploying', () => {
    const phases = [];
    release.releaseProduction({
      deploymentArgs: ['--dry-run'],
      runPhase(name, script, args) {
        phases.push({ name, script, args });
      }
    });
    assert.deepEqual(phases.map(phase => phase.name), [
      'source-mirror', 'tests', 'browser', 'import-benchmark', 'publish', 'deploy'
    ]);
    assert.match(phases[0].script, /check-source-mirror\.mjs$/);
    assert.match(phases[1].script, /test\/run-all\.js$/);
    assert.match(phases[2].script, /scripts\/smoke-browser\.js$/);
    assert.match(phases[3].script, /scripts\/benchmark-import-reliability\.js$/);
    assert.deepEqual(phases[3].args, ['--candidate', 'HEAD']);
    assert.match(phases[4].script, /sync-public\.mjs$/);
    assert.match(phases[5].script, /deploy-production\.mjs$/);
    assert.deepEqual(phases[5].args, ['--dry-run']);
  });

  await check('publication failure prevents any production mutation', () => {
    const phases = [];
    assert.throws(() => release.releaseProduction({
      runPhase(name) {
        phases.push(name);
        if (name === 'tests') throw new Error('checks failed');
      }
    }), /checks failed/);
    assert.deepEqual(phases, ['source-mirror', 'tests']);
  });

  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
