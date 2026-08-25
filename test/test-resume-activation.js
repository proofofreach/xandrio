/**
 * Resume activation and recovery-ownership contracts in public/app.js.
 *
 * These are enforced against the source text rather than by running app.js:
 * app.js is the DOM entry point and is not loadable under test. The properties
 * guarded here are exactly the ones that produced the production incident, and
 * each is a shape a refactor can silently break:
 *
 *   - iOS grants audio.play() only inside the user-activation window opened by
 *     the tap. An `await` before play() closes it and the resume fails.
 *   - Every automatic recovery attempt loads a chapter, and each load creates a
 *     server-side HLS session. Overlapping or unbounded attempts turn one
 *     failed resume into a burst of encoder sessions.
 *
 * Run: node test/test-resume-activation.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app.js'),
  'utf8'
);

// Body of a top-level `function name(...)`/`async function name(...)`, matched
// to the first line that closes it at column zero.
function functionBody(name) {
  const pattern = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\}`, 'm');
  return appSource.match(pattern)?.[1] || '';
}

console.log('\n━━━ Resume activation & recovery ownership ━━━');

// --- Activation-safe resume -------------------------------------------------

for (const fn of ['togglePlayPause', 'resumeNativeSingleFileFromMediaSession']) {
  const body = functionBody(fn);
  assert(body.length > 0, `${fn} is present in app.js`);

  const rewindAt = body.indexOf('applySmartRewindForResume()');
  const playAt = body.indexOf('chunkPlayer.play()');
  assert(rewindAt !== -1, `${fn} applies Smart Rewind synchronously`);
  assert(playAt !== -1, `${fn} starts native playback`);
  assert(
    rewindAt !== -1 && playAt !== -1 && rewindAt < playAt,
    `${fn} applies the rewind before starting playback`
  );
  // Everything strictly between the two calls. The `await` that belongs to
  // play() itself is expected and is trimmed before the check.
  const between = rewindAt === -1 || playAt === -1
    ? ''
    : body
      .slice(rewindAt + 'applySmartRewindForResume()'.length, playAt)
      .replace(/await\s*$/, '');
  assert(
    !between.includes('await'),
    `${fn} never awaits between the user gesture and play() (iOS activation)`
  );
}

assert(
  !appSource.includes('applySmartRewindBeforeResume'),
  'the awaiting Smart Rewind helper is gone (it reloaded nonseekable HLS before play)'
);
assert(
  /function applySmartRewindForResume\(\) \{/.test(appSource),
  'the synchronous Smart Rewind helper is not declared async'
);

// --- Single-flight recovery -------------------------------------------------

const recoveryBody = functionBody('scheduleAutomaticPlaybackRecovery');
assert(recoveryBody.length > 0, 'scheduleAutomaticPlaybackRecovery is present');

assert(
  /const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 2;/.test(appSource) &&
    /automaticRecoveryAttempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS/.test(recoveryBody),
  'automatic recovery is capped at two attempts before handing over to the user'
);
assert(
  recoveryBody.indexOf('!navigator.onLine') !== -1 &&
    recoveryBody.indexOf('!navigator.onLine') < recoveryBody.indexOf('automaticRecoveryAttempts += 1'),
  'offline waits do not spend an automatic recovery attempt'
);
assert(
  /function recoverIdleUnreadyPlayback\(/.test(appSource),
  'an idle unready Play has a prepare-before-Resume owner'
);

// The guard must stay held for the whole attempt. Releasing it at the top of
// retry() — as the original did — let a second error start a parallel recovery
// while the first loadChapter was still in flight, so two sessions were created.
const retryStart = recoveryBody.indexOf('const retry = async ()');
const retryBody = retryStart === -1 ? '' : recoveryBody.slice(retryStart);
const clearsGuardInFinally = /finally \{[\s\S]*?automaticRecoveryTimer = null/.test(retryBody);
assert(
  clearsGuardInFinally,
  'the in-flight guard is released in a finally block, not before the awaited work'
);
assert(
  /recoveryToken/.test(recoveryBody),
  'recovery attempts carry an ownership token so a stale attempt cannot commit'
);

assert(
  /(429|RETRY_AFTER|retryAfter)/i.test(appSource) &&
    /function handleChunkError/.test(appSource),
  'playback error handling accounts for a rate-limited (429) playback session'
);

// --- Manual resume ----------------------------------------------------------
// Secondary guards only. The behavioural coverage — that the Resume action
// reaches play() inside a live activation window, and that the captured tuple is
// replayed verbatim — lives in test-playback-session.js, which executes app.js.

const preparedResumeBody = functionBody('resumeFromPreparedSource');
assert(preparedResumeBody.length > 0, 'resumeFromPreparedSource is present');
assert(
  !/^async function resumeFromPreparedSource/m.test(appSource),
  'the Resume tap handler is not async (it must reach play() in the same turn)'
);
{
  const playAt = preparedResumeBody.indexOf('chunkPlayer.play()');
  assert(playAt !== -1, 'the Resume tap handler starts playback');
  assert(
    !preparedResumeBody.slice(0, playAt).includes('await'),
    'the Resume tap handler never awaits before play()'
  );
}

const manualBody = functionBody('offerManualPlaybackRecovery');
assert(
  !/loadChapter/.test(manualBody),
  'offering recovery does not itself load — preparation is separate from the tap'
);
assert(
  /actionLabel: 'Resume'/.test(appSource) && /actionLabel: 'Try again'/.test(appSource),
  'a failed preparation offers "Try again" rather than claiming one-tap Resume'
);
{
  // Resume must only be advertised after the source is prepared.
  const prepareBody = functionBody('prepareManualResume');
  assert(prepareBody.length > 0, 'prepareManualResume is present');
  const loadAt = prepareBody.indexOf('await loadChapter(');
  const resumeOfferAt = prepareBody.indexOf("actionLabel: 'Resume'");
  assert(
    loadAt !== -1 && resumeOfferAt !== -1 && loadAt < resumeOfferAt,
    'the source is loaded before the Resume action is offered'
  );
}

// --- Gapless chapter boundary ----------------------------------------------
// The engine hands the element the next chapter from inside the `ended` event.
// Anything the app does afterwards runs on a phone that may already be locked,
// where a load can no longer complete: bookkeeping only, never media work.

{
  const advanceBody = functionBody('handleGaplessChapterAdvance');
  assert(advanceBody.length > 0, 'handleGaplessChapterAdvance is present');
  assert(
    !/loadChapter|audioPlayer\.|chunkPlayer\.(play|pause|seek|loadChapter)/.test(advanceBody),
    'a gapless advance never reloads or re-drives the media element'
  );
  assert(
    /onChapterAdvance: handleGaplessChapterAdvance/.test(appSource),
    'the engine reports gapless advances to the app'
  );
  assert(
    /resolveNextChapterUrl:/.test(appSource) && /localChapterSource\(/.test(functionBody('createSingleFileChapterEngine')),
    'only a chapter already on this device is offered for pre-warming'
  );
}

{
  const body = functionBody('loadChapter');
  assert(body.length > 0, 'loadChapter is present in app.js');
  assert(
    !appSource.includes('ONLINE_LOCAL_FIRST_ENABLED'),
    'the online local-first soak flag is gone'
  );
  assert(
    /options\.bypassLocalSource/.test(body) &&
      /await localChapterSource\(currentBook\.id, index\)/.test(body) &&
      !/offlineMode\s*\?/.test(body.split('await localChapterSource')[0].slice(-200)),
    'loadChapter always consults the local chapter source unless explicitly bypassed'
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
