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
| `--radius-cover` | `4px` |
| `--radius-sheet` | `24px` |
| `--space-1/2/3/4/6/8` | `4/8/12/16/24/32px` |
| `--weight-regular/semibold/bold` | `400/600/700` |
| `--touch-min` | `45px` |

- Inter remains the interface family. Use regular for body and supporting text, semibold for titles and controls, and bold for primary emphasis. Do not introduce intermediate weights.
- Use the spacing scale for grouped content and section separation. Phone gutters remain 16px plus safe-area protection; compact shelf rows retain their optical spacing and full-size touch targets.
- Covers use 4px corners, ordinary controls and cards use 8px, and modal or sheet shells use 24px. Bottom sheets round only their top corners. Circular transport controls remain circular.

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
- Resume-card titles, metadata, and Play occupy explicit rows beside the cover, keeping the action within the cover's vertical span.
- Settings are grouped by Listening, Voices, Library & Sources, and Server & Account. Voice creation is an explicit disclosure, separate from choosing a narrator.
- Composition refinements live in composition.css and library-composition.css, both versioned in the offline app shell.

- Download is one request: prepare server audio, automatically save it on this device, then verify it. Rows show preparation progress with a spinner and verified completion with a checkmark. Menus show status text and Cancel download during work; Remove download appears only after completion. Device transfer guidance says to keep Xandrio open.
