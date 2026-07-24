const express = require('express');
const http = require('http');
const {
  decorateSourceDescriptors,
  filterEnabledAlternatives,
  operatorPolicyStatus,
  sourceEnabled
} = require('../lib/operator-policy');
const { registerOperatorPolicyRoutes } = require('../lib/routes/operator-policy-routes');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  const blank = operatorPolicyStatus({});
  assertEqual(blank, {
    version: 1,
    acknowledged: false,
    acknowledgedAt: null,
    unverifiedSourcesEnabled: false
  }, 'new instances start without an operator acknowledgement');
  assert(sourceEnabled('gutenberg', blank), 'rights-metadata providers remain available before acknowledgement');
  assert(!sourceEnabled('annas', blank), 'unverified providers require acknowledgement and enablement');

  const descriptors = decorateSourceDescriptors([
    { id: 'gutenberg', configured: true, requiresOperatorAcknowledgement: false },
    { id: 'annas', configured: true, requiresOperatorAcknowledgement: true },
    { id: 'zlibrary', configured: false, requiresOperatorAcknowledgement: true }
  ], blank);
  assert(descriptors[0].enabled && descriptors[0].acknowledged, 'verified descriptor is enabled and does not require acknowledgement');
  assert(!descriptors[1].enabled && !descriptors[1].acknowledged, 'unverified descriptor exposes the blocked state');
  assert(!descriptors[2].enabled, 'unconfigured descriptor remains disabled');
  assertEqual(filterEnabledAlternatives([
    { source: 'annas', hash: 'a' },
    { source: 'gutenberg', hash: 'g' }
  ], blank).map(item => item.hash), ['g'], 'automatic fallback cannot bypass the instance source policy');

  let settings = {};
  let cacheUpdate;
  const store = {
    async load() { return settings; },
    async update(_file, mutator) {
      const result = await mutator(settings);
      return result;
    }
  };
  const app = express();
  app.use(express.json());
  registerOperatorPolicyRoutes(app, {
    settingsFile: '/tmp/settings.json',
    jsonStore: store,
    now: () => '2026-07-12T12:00:00.000Z',
    updateSettingsCache: value => { cacheUpdate = value; }
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await request(base, 'GET', '/api/legal/operator-policy');
    assert(initial.status === 200 && initial.body.acknowledged === false,
      'operator policy route reports the unacknowledged instance state');

    const invalid = await request(base, 'PUT', '/api/legal/operator-policy', {
      acknowledged: false,
      unverifiedSourcesEnabled: true
    });
    assert(invalid.status === 400, 'enabling unverified sources requires an explicit acknowledgement');

    const saved = await request(base, 'PUT', '/api/legal/operator-policy', {
      acknowledged: true,
      unverifiedSourcesEnabled: true
    });
    assert(saved.status === 200 && saved.body.acknowledged && saved.body.unverifiedSourcesEnabled,
      'operator acknowledgement and source enablement persist together');
    assert(settings.operatorPolicy?.acknowledgedAt === '2026-07-12T12:00:00.000Z',
      'operator acknowledgement time is stored in instance settings');
    assert(cacheUpdate === settings, 'settings cache is refreshed after policy changes');

    const disabled = await request(base, 'PUT', '/api/legal/operator-policy', {
      acknowledged: true,
      unverifiedSourcesEnabled: false
    });
    assert(disabled.status === 200 && disabled.body.acknowledged && !disabled.body.unverifiedSourcesEnabled,
      'an acknowledged operator can disable all unverified sources again');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
