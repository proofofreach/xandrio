const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'views', 'player-ui.js'),
  'utf8'
);
const indexSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);
const match = source.match(
  /export function isPlaybackActionRequired\([^)]*\) \{[\s\S]*?\n\}/
);
const resumeStateMatch = source.match(
  /export function playbackNoticeStateForResumePrompt\([^)]*\) \{[\s\S]*?\n\}/
);

assert(match, 'player UI exports an explicit playback-notice policy');
assert(resumeStateMatch, 'player UI exports the resume-notice transition policy');
const policy = Function(
  `${match[0].replace('export ', '')}; return isPlaybackActionRequired;`
)();
const resumeState = Function(
  `${resumeStateMatch[0].replace('export ', '')}; return playbackNoticeStateForResumePrompt;`
)();

assert.strictEqual(policy('resume'), true, 'resume requires user action');
for (const state of ['active', 'ready', 'preparing', 'hidden', '', null]) {
  assert.strictEqual(
    policy(state),
    false,
    `${String(state)} does not require a playback notification`
  );
}

let state = 'preparing';
assert.strictEqual(policy(state), false, 'preparing stays quiet');
state = resumeState(true);
assert.strictEqual(state, 'resume', 'an interruption enters the actionable state');
assert.strictEqual(policy(state), true, 'an interruption shows the notice');
state = resumeState(false);
assert.strictEqual(state, 'hidden', 'successful resume clears the notice state');
assert.strictEqual(policy(state), false, 'operational playback stays quiet after resume');

assert(
  !/Best for lock screen|Preparing lock-screen playback/.test(
    source.match(/export function syncMiniPlayerInfo\(\) \{[\s\S]*?\n\}/)?.[0] || ''
  ),
  'mini-player chapter text stays quiet when lock-screen playback is operational'
);
assert(
  !source.includes('iphonePlaybackTip') && !indexSource.includes('iphone-playback-tip'),
  'the proactive iPhone playback tip is removed'
);

console.log('16 passed, 0 failed');
