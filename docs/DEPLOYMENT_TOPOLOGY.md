# Deployment topology — what runs where

One codebase, two instances, delineated by environment configuration (never by
forked code). The sanitized public export (`scripts/release/prepare-public-root.mjs`
→ the public repository → `git` checkout on the web host) ships the whole tree;
each instance enables only its own features via `.env`.

## Production (xandrio.xyz — remote web host, nginx → `xandrio-web` systemd unit)

Enabled:
- Accounts, sessions, roles, shelves — the multi-user surface (`data/accounts.json`,
  `data/sessions.json`, `data/shelves.json`). `XANDRIO_TOKEN` stays set as the
  admin Bearer credential for scripts/monitoring.
- Library, import/upload, search providers, Anna's/Z-Library (with
  `BOOK_PROXY_URL` egress proxy), covers, playback, PWA/offline.
- Edge TTS (network engine; no local model runtime needed).

Disabled (must stay off in production `.env`):
- `XANDRIO_VOICE_PROVIDERS=edge,kokoro` — the voice catalog (picker, voice
  selection, voice cloning) only offers providers listed here; Chatterbox
  voices and the cloning UI never appear on the web host.
- `CHATTERBOX_AUTO_START=false` (and `KOKORO_AUTO_START` as appropriate) —
  disabled model engines never spawn. The `m4-server/` and `python/` trees
  ship with the code but are inert without these flags and a local runtime.

## Local (Apple-Silicon M4 — launchd `com.xandrio.server`, port 8181, trusted LAN)

- Everything production has, plus the heavy TTS engine stack: Kokoro and
  Chatterbox/MLX model servers (`m4-server/`, project venvs), voice cloning and
  voice references, premium background prep.
- Runs in trusted-LAN mode (no token, no accounts) unless accounts are created
  here too; accounts are per-instance (`data/` is not shared between instances).

## Promotion — when a feature is "proven"

Local is the proving ground; production only runs promoted work. A feature is
promoted, in order:

1. Developed on a short-lived branch off `main`; merged back to `main` with the
   full `npm test` suite and `npm run test:browser` green. `main` is the only
   branch `sync:public` will publish (`--allow-source` exists for deliberate
   exceptions only).
2. Any new runtime/engine capability is gated behind an env flag that defaults
   **off** and is documented in `.env.template`, so shipping the code is
   harmless before the flag is enabled anywhere.
3. The feature runs enabled on the local M4 instance for a soak period of real
   use (3–7 days as a default; longer for playback/audio-path changes) with no
   regressions.
4. Only then: `npm run sync:public` from `main` and wait for the public PR to
   merge. Promote that public revision with
   `npm run deploy:production -- --ssh-target user@host`; this refuses private
   patches missing from public `main`, invokes `scripts/deploy-prod.sh` on the
   VPS, and verifies the VPS revision, `xandrio-web`, and the external health
   endpoint. If flag-gated, enable the flag in the production `.env`.

"Local has more than production" therefore means more *enabled flags*, never
more *code*: both instances run the same lineage, and divergence lives in
`.env` alone.

## Rules

- New user-facing features (like accounts) go to production through the normal
  release export; nothing is cherry-picked or hot-edited on the server —
  server-local edits get lost on the next deploy. Operators promote from the
  private checkout with `npm run deploy:production`; the command runs
  `scripts/deploy-prod.sh` on the web host and prints a verified production
  receipt (see docs/SELF_HOSTING.md).
- A local service restart, localhost health response, or push to the private
  repository is development activity. None is evidence of a production
  deployment.
- New engine/runtime features stay local-only by default: gate them behind an
  explicit env flag that defaults to off, so shipping the code to production is
  harmless.
- Per-instance state (`data/`, `cache/`, `.env`) never moves between instances
  as part of a deploy.
