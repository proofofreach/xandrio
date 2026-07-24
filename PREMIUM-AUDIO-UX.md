# Progressive Premium Audio — UX Specification

Instant playback with a fast local engine (Kokoro), transparent background
regeneration with the premium engine (Chatterbox Turbo), per-chapter
readiness, and seamless switchover. Design consulted against the
`ui-ux-pro-max` / `ui-ux-promax` skills and grounded in the app's existing
component vocabulary (voice sheet, `hq-voice-prep` panel, cache badges,
toast, chapter sheet).

## Design principles applied

- **Reframe**: the user chooses a *voice experience*, not an engine. Engine
  names stay in the advanced filter chips; primary copy speaks in
  "Instant" / "Premium".
- **Fewest elements**: no new surfaces. Extend the existing per-chapter
  `hq-voice-prep` panel to book scope; reuse cache badges, the voice status
  line, and the chapter sheet.
- **No mid-stream surprises**: never swap voices mid-chapter. Upgrades apply
  at chapter boundaries.
- **Color is never the sole indicator**; all status is text + `aria-live`
  (existing panel already does this).
- **No new accent colors, gradients, or glow.** Existing state palette only.

## 1. Voice selection = intent

Selecting a premium voice (e.g. Brick Scott) means: *play instantly with the
paired instant voice; upgrade chapters to premium in the background as they
become ready.*

- Each premium voice declares a paired instant fallback voice, matched for
  gender/character continuity (`brick-scott` → `kokoro:am_onyx`, the deep
  male Kokoro voice — confirmed pairing July 2026), configurable server-side.
- The voice card keeps its existing badges. The "Turbo" tier badge is
  renamed **Premium**; card meta shows "Instant start · premium upgrade" for
  paired voices.

## 2. Book-level prep panel (extends `hq-voice-prep`)

Shown in the player when a premium voice is active and the book is not fully
premium-ready. Same markup family: title, one-line detail, progress track,
count.

| State | Detail copy | Notes |
|---|---|---|
| generating | `Preparing premium audio — 12 of 30 chapters` | fill = ready/total |
| paused | `Paused while playing — resumes when idle` | generation yields to live TTS |
| ready | `Premium audio ready` | auto-hide after ~4s |
| error | `Premium generation failed — Retry` | single retry action |

The existing "Prepare chapter" button becomes **Prepare book** (starts/none
if auto-start is on). Panel remains `aria-live="polite"`.

## 3. Playback + switchover rules

- Chapter opens → serve premium variant if its audio is complete, else the
  instant variant. The `/api/chunks/:book/:chapter/status` (or audio
  response) carries `servedTier: 'instant' | 'premium'`.
- If premium becomes ready **while playing the instant version**, do not
  interrupt. At the next chapter boundary the premium variant plays.
  One-time quiet toast on first occurrence per book: `Premium voice starts
  next chapter`.
- Re-opening a chapter later always picks the best available variant.
- Voice status line (`player-voice-status`): `Brick Scott · Premium` or
  `Brick Scott · Instant (premium preparing)`.

## 4. Chapter sheet readiness

In premium mode only, chapters whose premium audio is complete get a small
leading dot + `aria-label="Premium audio ready"` on the existing
`chapter-list-item` row. No badge text (avoid list noise); the dot uses the
existing "ready" state color already used by cache badges.

## Benchmark (M4, 24GB, July 2026 — 336-char paragraph, brick-scott ref)

| Engine | Processing for ~19s audio | RTF (lower = faster) | Peak mem |
|---|---|---|---|
| Kokoro am_onyx (deep male, pairs with brick-scott) | 4.1s | 0.22 | small |
| Chatterbox Original, PyTorch MPS | 194s | 9.42 | ~5GB |
| Chatterbox Turbo, PyTorch MPS | 28–72s | 1.51–3.5 | ~4GB |
| Chatterbox Turbo, MLX fp16 | 12.8–22.9s | 0.67–1.18 (thermal-dependent) | 4.7GB |
| Chatterbox Turbo, MLX 8-bit | 8.9–9.5s | 0.46–0.49 (consistent) | 2.8GB |
| **Chatterbox Original, MLX 8-bit** | **11.5s** | **0.54 (CFG intact)** | **2.3GB** |

Headline: MLX 8-bit runs the ORIGINAL model (the quality bar, with
classifier-free guidance) at faster than realtime — 17× quicker than the
same model on PyTorch MPS, whose RTF 9.42 was framework overhead, not model
cost. Original-8bit (`mlx-community/chatterbox-8bit`) is the leading premium
engine candidate; Turbo-8bit is the fallback if Original's quantized output
disappoints by ear. Samples for A/B listening are in
`tts-benchmark-samples/`. Model: `mlx-community/chatterbox-turbo-8bit` via
`mlx-audio` (pin `transformers==4.57.1`; requires the
`mlx-community/S3TokenizerV2` sidecar model for voice conditioning).

## 5. Generation scheduling (server)

- Queue order: current chapter, then forward from the listening position,
  then remaining chapters, then backmatter.
- Background priority; **pause whenever an immediate-priority TTS job or
  active Kokoro generation is running** (both engines share the GPU — the
  benchmark showed 2.5× slowdown under contention).
- `.texthash` sidecars are written for all premium output, so text changes
  auto-invalidate (existing mechanism).
- Settings: single toggle `Prepare premium audio in background` (default
  on). No further knobs.

## 6. Failure and offline

- Chatterbox engine down: prep panel state `paused` with copy `Premium
  engine offline — instant voice continues`. Playback is never blocked.
- Repeated chunk failures: panel `error` state with one Retry.

## Copy inventory (all user-facing strings)

- Prepare book · Preparing premium audio — N of M chapters · Paused while
  playing — resumes when idle · Premium audio ready · Premium generation
  failed — Retry · Premium voice starts next chapter · Instant (premium
  preparing) · Premium engine offline — instant voice continues
