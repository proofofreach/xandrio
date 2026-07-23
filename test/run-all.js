/**
 * Test Runner — Executes all test suites and reports totals
 *
 * Run:  node test/run-all.js
 */

const { execSync } = require('child_process');
const path = require('path');

const tests = [
  'test-generation-scheduler.js',
  'test-abortable-edge-tts.js',
  'test-premium-audio.js',
  'test-engine-registry.js',
  'test-narration-runtime.js',
  'test-playback-orchestrator.js',
  'test-playback-routes.js',
  'test-pronunciation-repair.js',
  'test-queue.js',
  'test-chunked-tts.js',
  'test-audio-quality.js',
  'test-engine-status.js',
  'test-voice-authority.js',
  'test-route-error-safety.js',
  'test-client-settings.js',
  'test-app-shell-versions.js',
  'test-server.js',
  'test-json-store.js',
  'test-auth.js',
  'test-rate-limit.js',
  'test-concurrency-limit.js',
  'test-graceful-shutdown.js',
  'test-security-http.js',
  'test-python-locks.js',
  'test-docker-context.js',
  'test-release-public-root.js',
  'test-release-repository-controls.js',
  'test-data-dir.js',
  'test-book-document.js',
  'test-book-importer.js',
  'test-source-provenance.js',
  'test-epub-parser.js',
  'test-epub-parsing.js',
  'test-pdf-extraction.js',
  'test-kindle-extraction.js',
  'test-internet-archive-provider.js',
  'test-opds-provider.js',
  'test-search-providers.js',
  'test-operator-policy.js',
  'test-zlibrary.js',
  'test-zlibrary-routes.js',
  'test-remote-fetch.js',
  'test-acquisition-fetch-safety.js',
  'test-annas-origin.js',
  'test-annas-routes.js',
  'test-pinned-browser-proxy.js',
  'test-search-cover-service.js',
  'test-cover-service-security.js',
  'test-search-work-groups.js',
  'test-search-query.js',
  'test-catalog-search.js',
  'test-user-library-state.js',
  'test-playback-session.js',
  'test-chapter-navigation.js',
  'test-chapter-structure.js',
  'test-search-ranking.js',
  'test-listening-stats.js',
  'test-chapter-labels.js',
  'test-book-timeline.js',
];

const testDir = __dirname;
let totalPassed = 0;
let totalFailed = 0;
let suitesRun = 0;
let suitesFailed = 0;
let suitesSkipped = 0;

// Take the LAST "N passed"/"N failed" match: it's the suite's final summary
// line. The first match could be any incidental log line.
function lastCount(output, word) {
  const matches = [...output.matchAll(new RegExp(`(\\d+)\\s+${word}`, 'g'))];
  return matches.length ? parseInt(matches[matches.length - 1][1]) : 0;
}

console.log('╔══════════════════════════════════════════════════╗');
console.log('║        Xandrio Audiobook Player Tests         ║');
console.log('╚══════════════════════════════════════════════════╝');

for (const testFile of tests) {
  const testPath = path.join(testDir, testFile);
  const suiteName = testFile.replace(/^test-/, '').replace(/\.js$/, '');

  console.log(`\n┌─── Suite: ${suiteName} ───────────────────────────`);

  try {
    const output = execSync(`node "${testPath}"`, {
      cwd: path.join(testDir, '..'),
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const suitePassed = lastCount(output, 'passed');
    const suiteFailed = lastCount(output, 'failed');
    const suiteSkipped = /SUITE SKIPPED/.test(output);

    totalPassed += suitePassed;
    totalFailed += suiteFailed;
    suitesRun++;

    // Print condensed output (skip blank lines, indent)
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      console.log(`│ ${line}`);
    }

    if (suiteFailed > 0) {
      suitesFailed++;
      console.log(`└─── ❌ ${suiteName}: ${suitePassed} passed, ${suiteFailed} FAILED`);
    } else if (suiteSkipped) {
      suitesSkipped++;
      console.log(`└─── ⚠️  ${suiteName}: SKIPPED (no fixtures available — ran 0 tests)`);
    } else if (suitePassed === 0) {
      // A suite that reports neither passes, failures, nor an explicit skip
      // is broken — don't let it read as green.
      suitesFailed++;
      totalFailed += 1;
      console.log(`└─── ❌ ${suiteName}: reported 0 tests without declaring SUITE SKIPPED`);
    } else {
      console.log(`└─── ✅ ${suiteName}: ${suitePassed} passed`);
    }

  } catch (err) {
    suitesRun++;
    suitesFailed++;

    // execSync throws on non-zero exit — capture stderr + stdout
    const output = (err.stdout || '') + (err.stderr || '');

    const suitePassed = lastCount(output, 'passed');
    const suiteFailed = lastCount(output, 'failed');

    totalPassed += suitePassed;
    totalFailed += suiteFailed || 1; // At least 1 failure if we got here

    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      console.log(`│ ${line}`);
    }

    console.log(`└─── ❌ ${suiteName}: FAILED (${suitePassed} passed, ${suiteFailed || '?'} failed)`);
  }
}

// ─── Grand Total ─────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════╗');
console.log(`║  TOTAL: ${totalPassed + totalFailed} tests — ${totalPassed} passed, ${totalFailed} failed`);
console.log(`║  Suites: ${suitesRun} run, ${suitesFailed} with failures, ${suitesSkipped} skipped`);
console.log('╚══════════════════════════════════════════════════╝');

if (totalFailed > 0 || suitesFailed > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!\n');
  process.exit(0);
}
