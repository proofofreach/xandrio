# SHIP.md

Production-readiness ledger, maintained by the `ship-readiness` skill.
Item IDs refer to `~/.claude/skills/ship-readiness/references/checklist.md`.

**Verdict:** READY, D8 blocked (scope: playback health aggregates only) · **Last run:** 2026-10-27 · **Event:** data

## Facts

| Fact | Value | Source |
|---|---|---|
| Public URL | https://xandrio.xyz | docs/DEPLOYMENT_TOPOLOGY.md |
| Stores personal data | Yes; this run adds listener playback-health aggregates | lib/playback-health.js |
| Repo visibility | Private source, sanitized public mirror | `npm run sync:public` |

## Triggered tiers

T1-data, scoped to `POST /api/playback-health` and `data/playback-health.json`. T0 and the other tiers were not run in this pass.

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

## Accepted risks

| ID | Accepted by | Reason | Revisit when |
|---|---|---|---|
| D2-small-instance | pending owner | With one listener per device class, a day's aggregate describes that listener; the admin can already see positions | More than one account per device class, or outside users |
