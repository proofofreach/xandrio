#!/usr/bin/env node
// Test-only scenario-shots replacement for verify-scenario-gate-exit.js.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const shotsRoot = path.join(root, 'artifacts', 'scenario-shots');
const variant = process.env.SCENARIO_SHOTS_VARIANT || 'default';
const groups = {
  library: ['cold', 'empty', 'loading', 'error', 'offline', 'degraded', 'full'],
  search: ['empty', 'loading', 'error', 'full'],
  settings: ['loading', 'error', 'degraded', 'full'],
  stats: ['empty', 'loading', 'error', 'full'],
  guide: ['loading', 'error', 'full'],
  player: ['loading', 'error', 'degraded', 'full'],
  login: ['error', 'offline', 'full']
};
const overlays = {
  player: ['chapters', 'bookmarks', 'voice', 'voice-degraded', 'speed', 'sleep', 'pronunciation'],
  activity: ['active']
};

let count = 0;
for (const [view, states] of Object.entries(groups)) {
  for (const state of states) {
    const destination = path.join(shotsRoot, view, state, 'mobile_dark_nopreference_normal.png');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Deliberately make two semantic states byte-identical.
    fs.writeFileSync(destination, view === 'library' && (state === 'cold' || state === 'empty') ? 'same' : `${view}:${state}`);
    count++;
  }
}
for (const [view, states] of Object.entries(overlays)) {
  for (const state of states) {
    for (const variant of ['mobile_dark_nopreference_normal.png', 'desktop_dark_nopreference_normal.png']) {
      const destination = path.join(shotsRoot, view, state, variant);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, `${view}:${state}:${variant}`);
      count++;
    }
  }
}
for (; count < 90; count++) {
  const destination = path.join(shotsRoot, 'padding', `${count}.png`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `padding:${count}:${variant}`);
}
