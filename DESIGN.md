# Xandrio Design Notes

## Register

Xandrio is a quiet product/tool interface: dense enough for repeated use, but visually led by book covers and playback controls.

## Tokens

| Token | Value |
| --- | --- |
| `--bg` | `oklch(10% 0.012 255)` |
| `--surface` | `oklch(18% 0.011 255)` |
| `--surface-hover` | `oklch(23% 0.012 255)` |
| `--surface-raised` | `oklch(20% 0.012 255)` |
| `--surface-inset` | `oklch(13% 0.01 255)` |
| `--border` | `oklch(29% 0.014 255)` |
| `--text` | `oklch(94% 0.012 82)` |
| `--text-secondary` | `oklch(72% 0.014 82)` |
| `--accent` | `oklch(76% 0.14 82)` |
| `--danger` | `oklch(58% 0.22 29)` |
| `--success` | `oklch(64% 0.17 148)` |
| `--radius` | `8px` |
| `--touch-min` | `44px` |

## Patterns

- Sheets and modals use `registerSheet()` for focus trapping, `aria-hidden`, body state, and history-backed dismissal.
- Skeletons appear only for cold loads to avoid flicker on refresh.
- Continue-listening rail is hidden during library filtering and restored when filters clear.
- Toasts are reserved for state changes and failures.

## Anti-Patterns

- No `backdrop-filter`; prefer solid surfaces and cover-derived ambient art.
- No emoji UI icons.
- Do not move engine code into view modules. Engine state stays in `app.js` and is passed to views through getters/functions.
