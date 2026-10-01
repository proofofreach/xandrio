# iPhone PWA Test Checklist

Run this on a real iPhone in Safari and from the Home Screen PWA. Use the LAN or Tailscale URL for the dev server.

1. Cold load, library render, card swipe/delete snap, rail dismiss tap target.
2. Player ambient background, scrolling, and open/close sheets; watch for jank or battery-heavy blur.
3. Swipe up on the mini player does not fight page scroll or iOS bottom-edge gestures.
4. Chapter and voice sheets close via backdrop; no scroll bleed; focus trapping where possible.
5. Lock screen playback: title, artwork, controls, and skip interval match Settings. Background playback survives at least 5 minutes and chapter handoff works. Operational playback shows no in-app reliability notice; an interruption surfaces the resume action.
6. Back/forward behavior: iOS PWA edge-swipe closes sheets or returns to the library without requiring a browser back button.
7. Haptics may be unsupported; active/tap feedback still feels clear.
8. Safe areas: mini player controls, notch/Dynamic Island, and book-progress line are not clipped. Rotate to landscape on Search: the input, Search button, Filters sheet, mini player, and player top bar clear the Dynamic Island on both sides. In both orientations the Search label stays inside its button. Tap the search input: the page must not zoom, and the full-width Search button stays visible under the input with the keyboard open. In the installed Home Screen app, pinch-to-zoom still magnifies the page when no text field is focused.
9. Voice sample playback ducks the main player and restores volume afterward.

Likely failure areas to inspect first: expensive ambient blur, mini-player swipe threshold near iOS gestures, and stale Media Session metadata after playback handoff.

## Resume and downloaded playback

These cover the incident behavior described in `docs/ARCHITECTURE.md`
("Local-first playback", "Resume"). Automated tests cannot reach real iOS user
activation, so these remain the acceptance gate. The browser smoke does exercise
a real legacy-to-current service-worker handoff and asserts zero streaming.

Keep the server log visible: it prints `[playback] first HLS segment in …ms`.

**First-tap resume**

10. Play a streamed (not downloaded) book. Lock the phone, wait 15 minutes, then
    press play from the Lock Screen. Audio must start on the **first** press.
11. Repeat from Control Center, and from the in-app play button after a long
    pause. Each must start on the first press.
12. With Smart Rewind enabled, resume a streamed book after several long pauses.
    Playback must start immediately every time. A rewind toast may or may not
    appear — it must never appear without the position actually moving back.
13. Force an interruption (drop Wi-Fi mid-chapter). The "Resume" action must not
    appear until the audio is ready; when it appears, one tap must start
    playback. If it offers "Try again" instead, that is correct behavior for a
    failed preparation — it must not be labelled "Resume".

**One session per resume**

14. Watch `/api/audio-hls` in the server log across steps 10–13. A single resume
    must keep one canonical start offset across its two bounded automatic
    attempts and manual Resume preparation. Creeping offsets or a third
    automatic attempt after Resume appears are regressions.

**Downloaded playback is local**

15. Download a book fully. With Wi-Fi and cellular **on**, play it and confirm
    there is **no** `/api/audio-hls` or `/api/audio` traffic for that book. The
    status must read "Playing from this device".
16. Toggle airplane mode mid-chapter. Playback must continue uninterrupted.
17. Corrupt or evict one chapter (Safari → Storage), then play it. It must fall
    back to streaming **once**, show a status saying so, and the rest of the
    download must remain intact — the book must not be re-downloaded or lost.

**Honest download states**

18. Cancel a download part-way. The book must **not** appear under Downloaded
    and must not be marked as on-device; it should show its own partial label.
    The chapters already transferred must still play offline.
19. Download a book on a first install, before the service worker has taken
    control. It must show "Verifying", keep its audio, and become Downloaded
    after relaunching — never a failed or re-started download.

**Service-worker update**

20. Deploy a build with a new `CACHE_VERSION` while a downloaded book is
    installed. Open a fresh idle PWA page while another tab is playing. The new
    page must defer activation and show the reload/update action; the playing tab
    must keep its controller and audio. Close the playing tab, reload the idle
    page, and confirm it reloads once under the new worker. Playback of the
    downloaded book must stay local, with no `/api/audio-hls` or unscoped
    `/api/audio` request at any point.

## Playback intent and book identity

21. Play through Bluetooth, lock the phone, then disconnect and reconnect the
    headphones. Confirm the book title and position remain correct. Repeat,
    pressing Pause before reconnecting. Audio must stay paused after that
    explicit Pause. Run this in Safari and the installed Home Screen app.
22. Interrupt playback with a phone call or another audio app. Return to Xandrio,
    press Pause, then end the interruption. Audio must remain paused. One manual
    Play must resume the selected book without jumping to another chapter.
23. Use two books with distinguishable opening narration. Slow the development
    server's audio response, open A, then select B before A finishes loading.
    Press Play while B's saved position is loading. The title and audible book
    must agree. Repeat rapid A/B/C selection and Lock Screen Play. Only the
    latest selected book may play. A failed selection must preserve the previous
    book's resume point. Record the actual response delay used.

## Record physical-device evidence

Copy [the result template](docs/fixtures/iphone-playback-result-template.json)
to `output/playback-processing/` before running this checklist. Record the
immutable source and deployed revisions, service-worker/app versions, device
model, iOS version, Safari versus Home Screen app, audio output and connection.
Use anonymous book labels. For each playback check, record the observed title,
audible source, position, user action, expected result and pass/fail. Include a
screen recording or redacted playback ledger when available.

Keep unrun checks `not-run`. A desktop browser profile, WebKit run or simulated
lock screen does not count as physical iPhone evidence. The new build remains
physically unverified until a completed result file names that exact build.
