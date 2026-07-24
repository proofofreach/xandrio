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

## Rules

- New user-facing features (like accounts) go to production through the normal
  release export; nothing is cherry-picked or hot-edited on the server —
  server-local edits get lost on the next deploy.
- New engine/runtime features stay local-only by default: gate them behind an
  explicit env flag that defaults to off, so shipping the code to production is
  harmless.
- Per-instance state (`data/`, `cache/`, `.env`) never moves between instances
  as part of a deploy.
