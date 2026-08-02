# iPhone PWA Test Checklist

Run this on a real iPhone in Safari and from the Home Screen PWA. Use the LAN or Tailscale URL for the dev server.

1. Cold load, library render, card swipe/delete snap, rail dismiss tap target.
2. Player ambient background, scrolling, and open/close sheets; watch for jank or battery-heavy blur.
3. Swipe up on the mini player does not fight page scroll or iOS bottom-edge gestures.
4. Chapter and voice sheets close via backdrop; no scroll bleed; focus trapping where possible.
5. Lock screen playback: title, artwork, controls, and skip interval match Settings. Background playback survives at least 5 minutes and chapter handoff works. Operational playback shows no in-app reliability notice; an interruption surfaces the resume action.
6. Back/forward behavior: iOS PWA edge-swipe closes sheets or returns to the library without requiring a browser back button.
7. Haptics may be unsupported; active/tap feedback still feels clear.
8. Safe areas: mini player controls, notch/Dynamic Island, and book-progress line are not clipped.
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
