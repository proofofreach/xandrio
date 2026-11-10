/**
 * Client settings validation tests.
 *
 * Run: node test/test-client-settings.js
 */

const { sanitizeClientSettings, registerBookmarksRoutes } = require('../lib/routes/bookmarks-routes');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\n━━━ Client settings ━━━');

assertEqual(
  sanitizeClientSettings({ defaultSearchSources: ['annas', 'internetarchive', 'annas', 'invalid'] }).defaultSearchSources,
  ['annas', 'internetarchive'],
  'search source defaults are whitelisted and deduplicated'
);
assertEqual(
  sanitizeClientSettings({ defaultSearchSources: [] }).defaultSearchSources,
  undefined,
  'empty search source defaults are rejected'
);
assertEqual(
  sanitizeClientSettings({ defaultSearchSources: 'annas' }).defaultSearchSources,
  undefined,
  'non-array search source defaults are rejected'
);
assertEqual(
  sanitizeClientSettings({ smartRewindEnabled: false, rollingOfflineEnabled: true }),
  { smartRewindEnabled: false, rollingOfflineEnabled: true },
  'automatic playback settings accept booleans'
);
assertEqual(
  sanitizeClientSettings({ shelfRowDensity: 'comfortable' }),
  { shelfRowDensity: 'comfortable' },
  'shelf row density accepts compact or comfortable'
);
assertEqual(
  sanitizeClientSettings({ shelfRowDensity: 'huge' }).shelfRowDensity,
  undefined,
  'unknown shelf row densities are rejected'
);

// The PUT route, end to end against an in-memory store.
async function routeTests() {
  const handlers = new Map();
  const app = {};
  for (const method of ['get', 'put', 'post', 'patch', 'delete']) {
    app[method] = (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler);
  }
  const files = { settings: {} };
  registerBookmarksRoutes(app, {
    bookmarksFile: 'bookmarks',
    clientSettingsFile: 'settings',
    jsonStore: null,
    loadJSON: async file => structuredClone(files[file] || {}),
    updateJSON: async (file, mutator) => {
      const draft = structuredClone(files[file] || {});
      const result = await mutator(draft);
      files[file] = structuredClone(draft);
      return result;
    }
  });
  const call = async (method, body) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }
    };
    await handlers.get(`${method} /api/settings/client`)({ body, params: {}, query: {}, headers: { 'x-xandrio-user-id': 'user_a' } }, res);
    return res;
  };

  let res = await call('PUT', { settings: { defaultSpeed: 1.5, skipIntervalSeconds: 30 } });
  assertEqual([res.statusCode, res.body.settings], [200, { defaultSpeed: 1.5, skipIntervalSeconds: 30 }], 'a valid update is stored');

  res = await call('PUT', { settings: { defaultSpeed: null } });
  assertEqual([res.statusCode, res.body.settings], [200, { skipIntervalSeconds: 30 }], 'null resets the default speed');
  res = await call('GET');
  assertEqual(res.body.settings, { skipIntervalSeconds: 30 }, 'the reset survives a reload');

  res = await call('PUT', { settings: { skipIntervalSeconds: null, shelfRowDensity: 'comfortable' } });
  assertEqual(res.body.settings, { shelfRowDensity: 'comfortable' }, 'null resets any client setting');

  res = await call('PUT', { settings: { defaultSpeed: 9, shelfRowDensity: 'compact' } });
  assertEqual(res.statusCode, 400, 'an invalid non-null value is refused');
  res = await call('GET');
  assertEqual(res.body.settings, { shelfRowDensity: 'comfortable' }, 'a refused update changes nothing');

  res = await call('PUT', { settings: { smartRewindEnabled: 'yes' } });
  assertEqual(res.statusCode, 400, 'a mistyped boolean is refused');

  res = await call('PUT', { settings: 'defaultSpeed' });
  assertEqual(res.statusCode, 400, 'a non-object body is refused');

  res = await call('PUT', { settings: { unknownKey: 1 } });
  assertEqual([res.statusCode, res.body.settings], [200, { shelfRowDensity: 'comfortable' }], 'unknown keys are ignored');
}

routeTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, error => {
  console.error(error);
  process.exit(1);
});
