# Playback reliability verification

Run these checks with the supported Node 24 runtime, installed dependencies,
Playwright Chromium/WebKit, and ffmpeg. They use local synthetic audio and
controlled provider failures. They do not call production or paid narration
providers.

```sh
npm test
npm run verify:playback-reliability
PLAYBACK_RELIABILITY_BROWSER=webkit npm run verify:playback-reliability
npm run verify:playback-cross-feature
PLAYBACK_ADVERSARIAL_BROWSER=webkit npm run verify:playback-cross-feature
npm run verify:player-request-bounds
PLAYER_AUDIT_BROWSER=webkit npm run verify:player-request-bounds
npm run verify:generation-reliability
npm run verify:hls-maintenance
npm run verify:hls-failure-recovery
npm run verify:offline-startup
OFFLINE_STARTUP_BROWSER=webkit npm run verify:offline-startup
npm run verify:book-switch
npm run verify:narration
npm run benchmark:mobile-playback
npm run test:browser
```

Each new verification script writes JSON evidence under
`output/playback-reliability/`. Browser scripts also save traces and screenshots.
The output directory is local and is not part of the production release.

## Required behavior

- Startup needs contiguous audio at the requested position. Two unrelated ready
  clips cannot satisfy the gate. An error later in the chapter must not block an
  already playable startup buffer.
- Resume and seeking prioritize the requested clips. Whole-chapter assembly and
  next-chapter preparation run in the background.
- A halted generation job must report a blocked pending clip promptly. It must
  preserve clips that are ready or already being generated. Cancellation must
  release stream listeners.
- Preparation has a total deadline and a per-request deadline. Transient errors
  have bounded retries. Permanent errors and rate limits retain their status and
  `Retry-After` information.
- Preparation polls and audio requests retain the selected narrator and resume
  position. A different narrator's completed file cannot satisfy the request.
- Seeking into ungenerated audio prepares the new target before opening its
  transport. A pause during preparation stays paused, and a newer book load
  cancels the old seek. Source changes retain the effective playback speed.
- Seek completion balances preparation and ready notifications. Pending native
  playback has a deadline and stops on failure. Superseded operations do not
  trigger automatic recovery at an abandoned position.
- Timeline requests cannot overlap or outlive source teardown. Diagnostic
  requests after a media failure cannot leave the loading state stuck.
- HLS playlist polling reuses its encoder without scanning all retained segment
  files. Scheduled and explicit maintenance still enforce the storage limit.
- A failed HLS encoder cancels its upstream input. Completed segments stay
  readable; missing segments from the failed session report a permanent error.
- Looking up one downloaded chapter must not wait for migration of unrelated
  books or covers. Legacy audio remains isolated by account, and failed copies
  retain their source.

## Measurement limits

Browser timings cover deterministic local fixtures, including actual native
audio playback and ffmpeg output. They are not production latency claims or
physical-phone measurements. Android and iOS browser profiles do not replace
device lock-screen tests.

The offline startup verifier uses browser offline mode in Chromium. Playwright's
WebKit offline emulation also prevents playback of an already-created blob URL,
so its verifier instead makes the audio origin return 503. It checks cached
full and Range responses, a moving playhead, and zero audio requests to that
origin. Reports identify the transport mode.

Production checks must remain separate from these tests. A successful feature
branch push is not a deployment. Production deployment requires a successful
`npm run release:production` receipt for the exact active revision.
