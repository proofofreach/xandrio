# Hidden Features Handoff — Historical

This July 2026 handoff is complete and is retained only as decision history.
Do not execute its former task list or rely on its line numbers and asset
versions.

The implemented surfaces now live in:

- `public/js/features/offline.js` and `public/sw.js` for explicit offline downloads, network-first playback, and byte-range cache responses.
- `public/js/views/voices.js` and `lib/routes/preferences-routes.js` for engine health, voice selection, and custom Chatterbox voices.
- `public/js/views/library.js`, `public/js/views/player-ui.js`, and `server.js` for measured chapter progress.
- `public/js/features/bookmarks.js` and the sync routes for cross-device progress and client settings.

Current behavior and verification commands are documented in
`docs/ARCHITECTURE.md`, `docs/API.md`, and `docs/PERFORMANCE.md`.
