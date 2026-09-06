const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { autoSleepWindowKey, normalizeAutoSleepSchedule } = await import(
    pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'auto-sleep-schedule.mjs')).href
  );

  const overnight = { enabled: true, start: '23:00', end: '08:00' };
  assert.strictEqual(autoSleepWindowKey(overnight, new Date(2026, 8, 4, 22, 59)), null);
  assert.strictEqual(autoSleepWindowKey(overnight, new Date(2026, 8, 4, 23, 0)), '2026-09-04');
  assert.strictEqual(autoSleepWindowKey(overnight, new Date(2026, 8, 5, 2, 30)), '2026-09-04');
  assert.strictEqual(autoSleepWindowKey(overnight, new Date(2026, 8, 5, 7, 59)), '2026-09-04');
  assert.strictEqual(autoSleepWindowKey(overnight, new Date(2026, 8, 5, 8, 0)), null);

  const daytime = { enabled: true, start: '09:30', end: '17:00' };
  assert.strictEqual(autoSleepWindowKey(daytime, new Date(2026, 8, 5, 9, 29)), null);
  assert.strictEqual(autoSleepWindowKey(daytime, new Date(2026, 8, 5, 9, 30)), '2026-09-05');
  assert.strictEqual(autoSleepWindowKey(daytime, new Date(2026, 8, 5, 16, 59)), '2026-09-05');
  assert.strictEqual(autoSleepWindowKey(daytime, new Date(2026, 8, 5, 17, 0)), null);

  assert.strictEqual(
    autoSleepWindowKey({ enabled: true, start: '12:00', end: '12:00' }, new Date(2026, 8, 5, 12, 0)),
    null
  );
  assert.strictEqual(autoSleepWindowKey({ enabled: false }, new Date(2026, 8, 5, 23, 30)), null);

  assert.deepStrictEqual(normalizeAutoSleepSchedule(null), {
    enabled: false,
    start: '23:00',
    end: '08:00',
    minutes: 30,
    mode: 'time'
  });
  assert.deepStrictEqual(normalizeAutoSleepSchedule({
    enabled: 'true',
    start: '24:00',
    end: '8:00',
    minutes: 12,
    mode: 'chapters'
  }), {
    enabled: false,
    start: '23:00',
    end: '08:00',
    minutes: 30,
    mode: 'time'
  });
  assert.deepStrictEqual(normalizeAutoSleepSchedule({
    enabled: true,
    start: '00:00',
    end: '23:59',
    minutes: '45',
    mode: 'chapter'
  }), {
    enabled: true,
    start: '00:00',
    end: '23:59',
    minutes: 45,
    mode: 'chapter'
  });

  console.log('14 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
