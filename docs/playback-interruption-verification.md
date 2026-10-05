# Playback interruption verification

Use Node 24, installed dependencies, Playwright Chromium/WebKit, and ffmpeg.
These checks use local HTTP fixtures and native browser audio. They do not call
paid narration providers or change production.

```sh
npm test
npm run verify:voice-switch-races
VOICE_SWITCH_BROWSER=webkit npm run verify:voice-switch-races
npm run verify:native-interruption
NATIVE_INTERRUPTION_BROWSER=webkit npm run verify:native-interruption
npm run verify:audio-cache-recovery
```

Each script writes JSON evidence under `output/playback-interruption/`, in the
`voices`, `native`, or `backend` directory. Browser checks include screenshots
and Playwright traces. Keep baseline failure artifacts beside passing runs.

## Required behavior

- Selecting a chapter during playback continues playing. Selecting a chapter
  while paused keeps it paused.
- A delayed narrator save or preparation cannot undo a later Pause, reload a
  newly selected chapter, or override a chapter selection awaiting its save.
- A narrator change uses the latest listening position, including progress and
  deliberate seeks made while preparation is pending. The final reload uses
  the app's normal cancellation controls and bypasses audio downloaded in the
  previous narrator.
- Rewind and Skip Back start a fresh stall-detection window. Healthy playback
  remains uninterrupted at normal and slower speeds; a genuine stall is still
  reported once.
- A failed Play deadline stops the native pending request, so delayed media
  cannot start sound after failure. A replacement source retains ownership.
- HLS byte-quota cleanup protects sessions accessed within the last two minutes,
  including completed audio still being played. Idle sessions become eligible
  for eviction whether their encoder is running or finished. The separate
  retained-session count cap still evicts completed sessions by least recent
  access.
- Restart recovery rejects nonempty cached fragments that are too small for
  their narration recipe, and regenerates them before marking them ready.

Run the existing [reliability checks](deep-reliability-verification.md) and
[earlier playback checks](playback-reliability-verification.md) alongside these
cases after changing playback ownership, recovery, or cache maintenance.

## Limits

Browser-engine checks do not reproduce physical iPhone lock-screen, phone-call,
Bluetooth, or operating-system audio interruptions. The verifier exercises
the app's registered Media Session Pause callback where available and records an
explicit skip if the browser does not expose it. This is not a physical
lock-screen test. Held HTTP responses provide
repeatable network failures, not measurements of production network latency.

HLS storage can exceed the configured byte limit while requests keep sessions
active. The two-minute access lease expires after the last request. Session
admission limits bound concurrency, but do not bound active audio bytes.

The new cache check uses a conservative 12 kbit/s size floor based on narration
length. It detects obvious fragments, not plausible-size corruption in older
unverified files. Verified artifacts retain their size and SHA-256 checks. A
future output format below 12 kbit/s would need a different floor.
