# iPhone PWA Test Checklist

Run this on a real iPhone in Safari and from the Home Screen PWA. Use the LAN or Tailscale URL for the dev server.

1. Cold load, library render, card swipe/delete snap, rail dismiss tap target.
2. Player ambient background, scrolling, and open/close sheets; watch for jank or battery-heavy blur.
3. Swipe up on the mini player does not fight page scroll or iOS bottom-edge gestures.
4. Chapter and voice sheets close via backdrop; no scroll bleed; focus trapping where possible.
5. Lock screen playback: title, artwork, controls, and skip interval match Settings. Background playback survives at least 5 minutes and chapter handoff works.
6. Back/forward behavior: iOS PWA edge-swipe closes sheets or returns to the library without requiring a browser back button.
7. Haptics may be unsupported; active/tap feedback still feels clear.
8. Safe areas: mini player controls, notch/Dynamic Island, and book-progress line are not clipped.
9. Voice sample playback ducks the main player and restores volume afterward.

Likely failure areas to inspect first: expensive ambient blur, mini-player swipe threshold near iOS gestures, and stale Media Session metadata after playback handoff.
