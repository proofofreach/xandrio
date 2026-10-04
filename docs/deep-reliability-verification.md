# Deep reliability verification

These checks cover the second playback and general reliability audit. Use the
supported Node 24 runtime, installed dependencies, Playwright Chromium/WebKit,
and ffmpeg. All fixtures run locally. They do not call paid narration providers
or modify production.

```sh
npm test
npm run verify:app-lifecycle
APP_LIFECYCLE_BROWSER=webkit npm run verify:app-lifecycle
npm run verify:player-deep-races
DEEP_PLAYER_BROWSER=webkit npm run verify:player-deep-races
npm run verify:server-stream-lifecycle
npm run verify:scheduler-recovery
npm run verify:offline-integrity
npm run verify:storage-concurrency
npm run verify:position-conflicts
```

The scripts write JSON evidence under `output/deep-reliability/`. Browser checks
also retain screenshots and traces. Storage checks use independent processes
and temporary files; stream checks use HTTP and real ffmpeg output. Scheduler
checks use real queues and journal files with a controlled provider.

Run the existing checks in [playback-reliability-verification.md](playback-reliability-verification.md)
to verify the earlier fixes alongside these changes.

## Required behavior

- Main and mini Play controls show a disabled preparing state while the selected
  source cannot play. They become available when audio is ready. Existing Pause
  and recovery actions remain usable, including with keyboard input.
- Repeated Play on advancing audio succeeds without requiring a second native
  `playing` event. An abandoned chapter handoff cannot change a newer source or
  revive playback after Pause.
- Selecting a book does not inherit autoplay. Automatic chapter transitions
  explicitly retain native autoplay when prewarming is unavailable.
- Book completion cannot advance the queue, open another title, or expire a
  sleep timer after the user selects a different book. Duplicate in-flight
  completion events advance the queue once.
- A disconnected MP3 request and a failed encoder release their upstream work.
  The HLS startup deadline includes source preparation. A late directory create
  after cancellation cannot leave an orphan session.
- Cancelling generation during manifest creation cannot install stale state.
  Builds sharing a chapter cache path serialize disk mutations, including
  cache reuse, so a cancelled build cannot delete replacement audio. Unrelated
  chapters remain parallel. Late job events cannot mutate a replacement
  manifest. Releasing foreground ownership updates scheduler admission
  priority and durable claim ownership.
- Account changes wait for old offline writers to stop. Pending positions stay
  isolated by account, and positions queued during sync are retained.
- Pending positions remain durable until acknowledged. Failed account-storage
  fencing prevents the new identity from becoming active.
- Concurrent saves and stale-lock recovery cannot overlap their JSON writes.
  A killed writer releases its mutex. A busy writer does not block the event
  loop or unrelated files. An unavailable mutex fails closed.
- Automatic progress cannot move back a whole chapter. A delayed explicit
  rewind cannot overwrite a newer checkpoint. Current deliberate rewinds and
  subsecond checkpoint jitter remain supported.

## Storage mutex

JSON remains the data format. Node 24's built-in SQLite module provides only
the cross-process mutex. Each store has a persistent `.lock.sqlite` companion
with owner-only permissions; it contains no user JSON. Its transaction covers
PID-lock recovery, the JSON operation, and lock release. Contention retries
asynchronously with a zero SQLite busy timeout.

The PID lock remains for compatibility with older processes. Older versions do
not participate in the SQLite mutex, so avoid overlapping old and new writers
during an upgrade. PID reuse can still make a legacy PID lock appear live.
Do not delete an active mutex file to clear contention.

## Limits

These are local fault-injection checks, not production or physical-phone
latency measurements. Native audio is used where possible; selected failures
are injected after real metadata loads. Physical iOS lock-screen playback
requires a separate device check.

HLS timeout cancels its session and prevents later encoder startup. A source
preparation callback that ignores its AbortSignal may finish in the background.

Legacy global pending-position rows without a provable account remain retained
instead of being sent through another account. Equal-millisecond explicit
rewinds remain accepted to preserve the existing Smart Rewind contract; the
timestamp alone cannot establish an order for those writes.

Passing verification and pushing a feature branch are not production
deployment. Deployment requires a successful `npm run release:production`
receipt for the exact active revision.
