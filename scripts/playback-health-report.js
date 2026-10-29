#!/usr/bin/env node
// Prints the listener-reported playback health summary from the data store.
// Usage: node scripts/playback-health-report.js [--days N] [--data DIR]
'use strict';

const path = require('path');
const jsonStore = require('../lib/json-store');
const { summarizePlaybackHealth } = require('../lib/playback-health');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

(async () => {
  const days = Math.max(1, Number.parseInt(argument('--days', '7'), 10) || 7);
  const dataDir = argument('--data', process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const state = await jsonStore.load(path.join(dataDir, 'playback-health.json'), { days: {} });
  console.log(JSON.stringify(summarizePlaybackHealth(state, { days }), null, 2));
})().catch(error => {
  console.error(`Playback health report failed: ${error.message}`);
  process.exit(1);
});
