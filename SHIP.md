# SHIP.md

Production-readiness ledger, maintained by the `ship-readiness` skill.
Item IDs refer to `~/.claude/skills/ship-readiness/references/checklist.md`.

**Verdict:** READY, D8 blocked (scope: playback health aggregates; admin device telemetry) · **Last run:** 2026-11-10 · **Event:** data

## Facts

| Fact | Value | Source |
|---|---|---|
| Public URL | https://xandrio.xyz | docs/DEPLOYMENT_TOPOLOGY.md |
| Stores personal data | Yes; playback-health aggregates (2026-10-27); admin device telemetry (2026-11-10) | lib/playback-health.js, lib/client-telemetry.js |
| Repo visibility | Private source, sanitized public mirror | `npm run sync:public` |

## Triggered tiers

T1-data, scoped to `POST /api/playback-health` and `data/playback-health.json` (2026-10-27), and `/api/admin/client-telemetry` with `data/client-telemetry.json` (2026-11-10). T0 and the other tiers were not run in these passes.

## Items

| ID | Status | Evidence / reason | Date |
|---|---|---|---|
| D1 | pass | Inventory entry in docs/PRIVACY.md ("Playback health reports") | 2026-10-27 |
| D2 | pass | No per-user record exists: `normalizeReport` drops unknown fields, store keeps day×platform totals only; test "server aggregates by day and platform and expires old days" asserts no book id stored | 2026-10-27 |
| D3 | n/a | Aggregates are not attributable to a user, so there is nothing per-user to export | 2026-10-27 |
| D4 | pass | 35-day pruning in `createPlaybackHealthStore.record`; covered by the same test; PRIVACY.md states pruning runs on the next write | 2026-10-27 |
| D5 | n/a | No user-destructive action | 2026-10-27 |
| D6 | n/a | No uploads; JSON body via body-parser default limit, fields clamped in `normalizeReport` | 2026-10-27 |
| D7 | pass | Day keys are UTC (`utcDay`, toISOString) | 2026-10-27 |
| D8 | blocked | Encryption at rest for `/opt/xandrio/data` on the VPS is unconfirmed; applies to all of `data/`, not only this file | 2026-10-27 |
| D9 | n/a | No imports | 2026-10-27 |
| Abuse | pass | Route behind auth gate (not in `PUBLIC_API_PATHS`, lib/auth.js:35), CSRF middleware, `playback-health` rate-limit group 20/min/IP (lib/rate-limit.js) | 2026-10-27 |
| T-D1 | pass | Telemetry inventory paragraph in docs/PRIVACY.md ("Device telemetry is recorded only…") | 2026-11-10 |
| T-D2 | pass | Admin-only device diagnostics; 30-day/80-session expiry in `createClientTelemetryStore.record`; non-admin sign-in clears the device trail (`disable()` in public/js/admin-telemetry.mjs); no per-account delete route, data expires instead | 2026-11-10 |
| T-D3 | pass | `GET /api/admin/client-telemetry/:id` returns the full session JSON; Settings → Diagnostics "Copy full telemetry" | 2026-11-10 |
| T-D4 | pass | Test "sessions older than the retention window are removed on the next write" (test/test-client-telemetry.js) | 2026-11-10 |
| T-D6 | n/a | No uploads; JSON body ≤ 60 KB client-side, fields/strings/events clamped in `normalizeSession` | 2026-11-10 |
| T-D7 | pass | `startedAt` epoch ms, `receivedAt` ISO UTC; UI formats in local time | 2026-11-10 |
| T-Abuse | pass | `requireAdmin` on all three routes (test "routes require an administrator"), CSRF middleware, `client-telemetry` rate-limit group 30/min (lib/rate-limit.js) | 2026-11-10 |
| T-Covers | n/a | `<id>_cover_display.jpg` is a derived copy of an existing cover, removed with the book (lib/book-artifact-paths.js pattern) | 2026-11-10 |

## Accepted risks

| ID | Accepted by | Reason | Revisit when |
|---|---|---|---|
| D2-small-instance | pending owner | With one listener per device class, a day's aggregate describes that listener; the admin can already see positions | More than one account per device class, or outside users |
