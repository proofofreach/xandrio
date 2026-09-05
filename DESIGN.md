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
- Chapter transitions include five seconds of encoded silence so the listening rhythm survives background and lock-screen playback without relying on page timers.
- Toasts are reserved for state changes and failures.

## Anti-Patterns

- No `backdrop-filter`; prefer solid surfaces and cover-derived ambient art.
- No emoji UI icons.
- Do not move engine code into view modules. Engine state stays in `app.js` and is passed to views through getters/functions.

## Composition

- The player uses one alignment for chapter, narration status, timeline, and transport. Chapter navigation has one visible entry point. Book completion is a text summary; the selected timeline remains the seek control.
- Playback preparation and recovery stay in one status area between chapter and timeline on every viewport.
- Continue Listening uses horizontal resume cards. Shelf rows place offline actions beside the book metadata, with full-size touch targets. Open menus must escape the list paint boundary.
- Settings are grouped by Listening, Voices, Library & Sources, and Server & Account. Voice creation is an explicit disclosure, separate from choosing a narrator.
- Composition refinements live in composition.css and library-composition.css, both versioned in the offline app shell.
