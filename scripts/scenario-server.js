#!/usr/bin/env node
/**
 * Synthetic all-screen visual scenario server.
 *
 * Boots the real server.js/public bundle five times (once per dataset —
 * cold/empty/full/degraded/login), with every outbound provider, TTS, and
 * network call stubbed (see test/fixtures/scenarios/lib/network-guard.js and
 * provider-stub.js), behind one public proxy that routes each request to the
 * right dataset based on an `X-Xandrio-Scenario: <view>:<state>` header.
 *
 * Usage:
 *   npm run scenario:serve
 *   curl -H "X-Xandrio-Scenario: library:loading" http://127.0.0.1:8399/#/library
 *
 * See docs/SCENARIO_SERVER.md for the full scenario matrix and how to add to it.
 */
const { startScenarioEnvironment } = require('../test/fixtures/scenarios/lib/environment');
const { MATRIX } = require('../test/fixtures/scenarios/lib/matrix');

async function main() {
  const env = await startScenarioEnvironment({ log: message => console.log(`[scenario-server] ${message}`) });

  console.log('');
  console.log(`Scenario server ready: ${env.origin}`);
  console.log('Address a scenario with an X-Xandrio-Scenario: <view>:<state> request header, e.g.:');
  console.log(`  curl -H "X-Xandrio-Scenario: library:loading" ${env.origin}/`);
  console.log('');
  console.log('Applicable (view, state) combinations:');
  for (const [view, states] of Object.entries(MATRIX)) {
    const applicable = Object.entries(states).filter(([, cell]) => cell.applicable).map(([state]) => state);
    const skipped = Object.entries(states).filter(([, cell]) => !cell.applicable);
    console.log(`  ${view}: ${applicable.join(', ')}`);
    for (const [state, cell] of skipped) console.log(`    (skipping ${view}:${state} — ${cell.reason})`);
  }
  console.log('');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async () => {
    console.log('\n[scenario-server] shutting down…');
    await env.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
