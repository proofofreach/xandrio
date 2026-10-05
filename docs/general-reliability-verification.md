# Library and settings reliability verification

Use Node 24 and the installed Playwright Chromium/WebKit browsers. All checks
use local fixtures. They do not call narration providers or change production.

```sh
npm test
npm run verify:library-interactions
LIBRARY_E2E_BROWSER=webkit npm run verify:library-interactions
npm run verify:library-data-lifecycle
npm run verify:settings-ordering
SETTINGS_ORDERING_BROWSER=webkit npm run verify:settings-ordering
npm run verify:book-speed-races
BOOK_SPEED_BROWSER=webkit npm run verify:book-speed-races
```

JSON reports, browser traces, and screenshots are written under
`output/general-reliability/`. Keep baseline failure evidence beside passing
runs. The scripts record the failures they were designed to reproduce.

## Required behavior

- Only the latest library refresh can replace books or finish the loading
  indicator. Empty and failed loads do not display contradictory shelf hints.
- Deleting a resumed book removes its shelf row and Continue Listening card.
- Book menus support arrow keys, Home, End, Escape, and focus recovery after
  actions. Menu actions meet the existing 45px minimum touch target.
- Library rows remain painted and clickable after a desktop-to-phone viewport
  resize, including in WebKit.
- Shelf and listening-queue writes hold the same per-book state lock used by
  deletion. An operation cannot restore deleted book state after cleanup.
  Bulk queue updates acquire locks in sorted order. Unrelated book data remains.
- Invalid queue replacements return an error without clearing the queue.
- Rapid preference changes persist in order. A failed save does not block the
  next choice. Delayed profile loading preserves newer edits while loading
  remote preferences the listener has not changed.
- A delayed book-speed reset cannot change a newly opened book or override a
  newer speed choice. Book preference saves retain their order, and feedback
  describes the value that was saved. Keyboard speed changes choose the next
  preset in the requested direction, including from a custom speed.
- Queued preference writes retain the profile that created them. Changing sync
  profiles discards unsent writes from the previous profile. A response already
  in flight cannot replace the new profile's active book preferences.

## Limits

These fixtures test deliberate request ordering and local persistence. They do
not measure production latency or replace physical-device testing. Client
preference writes are ordered within one browser session; concurrent edits on
different devices retain the server's existing last-write behavior. Failed
preference saves remain local and display the existing device-only warning.

For playback or cache changes, also run the relevant checks documented in
[playback interruption verification](playback-interruption-verification.md)
and [deep reliability verification](deep-reliability-verification.md).
