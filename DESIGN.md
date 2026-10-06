# Xandrio Design Notes

## Register

Xandrio is a product/tool interface called "Readable". The owner's brief: HIGH FUNCTION, HIGH READABILITY. The owner swaps between books often, so switching books costs one tap. The UI is type, covers, and a few large controls. Themed and skeuomorphic treatments are vetoed.

## Tokens

Source: `public/style-v3.css` `:root`. Dark is the base. The light twin follows `prefers-color-scheme` and swaps the same tokens.

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#0B0B0D` | `#F2F2F7` |
| `--surface` / `--surface-raised` | `#1C1C1E` / `#232326` | `#FFFFFF` / `#FFFFFF` |
| `--surface-2` (= hover) / `--surface-inset` | `#2A2A2E` / `#141416` | `#E9E9EE` / `#E5E5EA` |
| `--border` / `--border-strong` / `--track` | `#2E2E33` / `#48484F` / `#3A3A40` | `#D9D9DE` / `#B8B8C0` / `#D1D1D6` |
| `--text` / `--text-secondary` / `--text-muted` | `#F5F5F7` / `#A6A6AD` / `#8E8E95` | `#141416` / `#5C5C66` / `#6E6E78` |
| `--accent` (fill) | `oklch(76% 0.14 82)` | same |
| `--accent-text` | `oklch(76% 0.14 82)` | `#704500` |
| `--on-accent` | `#0B0B0D` | `#141416` |
| `--danger` / `--danger-fill` | `#FF7A70` / `#C4302B` | `#B3261E` / `#B3261E` |
| `--success-text` / `--warning-text` / `--info-text` | `#5BD08A` / `oklch(80% 0.14 80)` / `#9CC3FF` | `#1E7A3C` / `#7A4A00` / `#1D5FBF` |
| `--focus-ring` | `oklch(84% 0.16 82)` | `#8A5500` |
| `--radius` / `--radius-cover` / `--radius-sheet` | `10px` / `4px` / `24px` | same |
| `--space-1/2/3/4/6/8` | `4/8/12/16/24/32px` | same |
| `--weight-regular/semibold/bold` | `400/600/700` | same |
| `--touch-min` | `45px` | same |

- Font: the system stack in `--font` (`-apple-system`, SF Pro, `system-ui`, Segoe UI, Roboto). No web font. Weights stay 400, 600, 700; 500 appears only on tab and tool labels.
- Type scale (Dynamic Type Large): large title 34, title1 28, title2 22, title3 20, headline 17, body 17, callout 16, subhead 15, footnote 13, caption 13. Body leading is 22px. Use `tabular-nums` on every time, count, and percent.
- Floor: nothing meaningful is under 13px. Footnote (13px) is for hints, column headers, and skip-button numerals only. Row titles are 17px; author and status lines are 15px.
- Contrast: body text at least 7:1 (primary 15.6:1, secondary 7.0:1 on surface, 5.9:1 on raised). Muted text at least 4.5:1. Targets are at least 44px (`--touch-min` 45px). Focus rings are 3px, `:focus-visible` only.
- Amber is a fill everywhere (play button, progress, selected states, dark text on it). Amber as text uses `--accent-text`: amber in dark mode, `#704500` in light mode. Never use `--accent` as text colour in the light twin.
- Status is words plus colour, never colour alone. Every state has a glyph or a word. Danger is a tinted card with a warning glyph and words; red supports and never leads.
- Gutters: 16px on phones (`--view-pad-*`, safe-area aware); the player uses 24px. Covers 4px, controls 8-14px, sheets 24px with only top corners rounded.

## Patterns

- One time vocabulary. `public/js/util/time-left.mjs` is the only formatter. Time left = remaining 1x audio / effective speed, written "9h 12m left". Minutes are rounded first and then split ("12h 00m", never "11h 60m"); under a minute is "< 1m"; zero is "Finished".
- Speed is stated once per surface. The library sort line says "Time left at 1.25×". A row adds " at 1.0×" only when its own speed differs from that reference. The player sentence always says it: "9h 12m left in the book at 1.25×". Prepared lead time is "2h 10m ready ahead", also at the selected speed.
- Chapter numbering is shared by the player, chapter sheet, mini player, Recent, Continue, library rows, and preparation messages through `chapter-labels.mjs`. Trust authored chapter numbers only when they strictly increase; their highest number is the total. Otherwise count narrative chapters in reading order, preferring sections typed `chapter`. Front matter, back matter, contents, dividers, and empty sections retain their names and do not count. Continue and resumed rows use "Ch 4 of 50". When cached structure is unavailable, omit the number; raw section counts do not prove a chapter position. A bounded read-only summary progressively fills labels for unopened books and the structure key invalidates them after a rebuild.
- Library status words come from `library-status.mjs`. A row shows one primary state: device state, then narration, then listening context. The row's offline control is one 44px glyph: arrow (download), ring with percent (preparing), check (on device), circular arrow (retry or failed).
- Truncation order for a status line: full "9h 12m left at 1.0× · Narration failed", then drop the speed suffix, then use the short state word ("Failed"). The state word never clips mid-word; the time clips first. Grid cells use short forms ("46% ready", "6h 02m · 1.0×") on two 13px lines.
- Sheets and modals use `registerSheet()` for focus trapping, `aria-hidden`, body state, and history-backed dismissal. Each sheet does one job. Focus goes to the sheet title on open.
- Toasts are for state changes and failures only. Dedupe by key (a repeat restarts the timer, no stacking). A toast is suppressed when an inline status area already shows the same key or error text (`registerInlineStatus`, `markInlineStatus`). Toasts dock above the tab bar and mini player; above an open sheet's top edge; under the player nav on phone and tablet. They never cover transport. Local confirmations ("Saved · 12:04") use `showInlineConfirmation` on the tool for about 2s, not a toast. Undo toasts last 5s; others 3s.
- Skeletons appear only for cold loads. Chapter transitions include five seconds of encoded silence for background and lock-screen playback.
- Download is one request: prepare server audio, automatically save it on this device, then verify it. Rows show a spinner with progress, then a check when verified. Menus show status text and Cancel download during work; Remove download appears only after completion. Guidance says to keep Xandrio open.
- Library narration readiness is stated only from narrator-aware activity or verified device evidence. A narrator-aware per-book summary endpoint is follow-up work; durations and import warm-up fields cannot prove readiness for the selected narrator.
- Prepared narrators wait by default. The user may choose an instant narrator instead; the choice is explicit and sits beside preparation status.
- Book Guides keep their existing constraints (nonfiction only; the admin tag lives in Settings › Study guides) and keep their own layout.

## Anti-Patterns

- No `backdrop-filter`; use solid surfaces.
- No emoji UI icons. No themed or skeuomorphic chrome.
- No colour-only status. No text under 13px. No hit target under 44px.
- No second time format, no repeated speed on one screen, no "11h 60m".
- Do not move engine code into view modules. Engine state stays in `app.js` and is passed to views through getters and functions. The shell only navigates through hash links; it owns no engine state.
- Do not toast what an inline status already says.

## Composition

- App shell (`shell.css`, `ui/shell.js`). Phone: tab bar Library / Find / Settings, hidden in the player. Desktop (760px and wider): a 232px sidebar with scope links and counts (My Shelf, Downloaded, Shared Library), Find books, Upload a file, Audio activity, Listening stats, Settings. `--shell-bottom` is the docked height; views and toasts clear it.
- Mini player: 64px on phones, 72px on desktop, with a 3px progress line. Phone shows play/pause and skip forward; skip back joins at 760px. Tap opens the player. Press and hold (500ms, 10px slop) opens the Recent sheet. The coach hint teaches this once (two or more in-progress books, mini player shown, not in the player) and stays dismissed.
- Library, phone: large title is the scope menu (My Shelf, Downloaded, Shared Library, Listening stats). Under it: the Continue strip, then the sort line ("Last played · Time left at 1.25×"), then rows. Desktop uses the sidebar scope links and hides the strip; the table is the switcher. A segmented scope control is a fallback only when the sidebar is absent.
- Continue strip: up to five in-progress books, 168 x 76px cards with a 44x66 cover, title, resume point "Ch 4 of 50 · 08:51", and a progress hairline. The timestamp drops when space is tight; the chapter label stays. One tap resumes. It is hidden while filtering and restored when filters clear.
- Rows: Compact is the default (72px, cover 44x66; 60px with a 34x51 cover on desktop). Title 17px semibold on one line with an ellipsis; author 15px with the resume chapter label beside it; one 15px status line; 44px offline control. Comfortable (Settings › Library › Shelf rows) is 96px with a two-line title clamp and a progress bar. Grid view uses four columns with a two-line title box. Open menus escape the list paint boundary.
- Desktop table columns: Book, Time left at speed, Narration, Offline.
- Player, top to bottom: nav (close, Now Playing, Recent, •••); cover at its real ratio, never cropped (cap `clamp(180px, 34svh, 340px)`, shrinks first on short phones or when a card shows); 22px title and 17px author; the narration line "Ryan · 2h 10m ready ahead" (the one entry to change narrator; engine stays in the accessible label and narrator sheet); the chapter row ("Chapter 12 of 50" and title), one tap to the Chapters sheet; the chapter timeline (elapsed and remaining; amber elapsed); the sentence "9h 12m left in the book at 1.25×" (plain text; Go to position in book lives in •••); transport; three tools.
- Transport is five buttons in one row, 16px gaps: Previous chapter 44px (28px glyph, secondary colour), Back 15 56px (44px glyph), Play/Pause 76px amber, Forward 15 56px, Next chapter 44px. Skips stay larger so the thumb finds them first.
- Tools: Speed (shows the value), Sleep (shows its countdown when armed), Bookmark (confirms inline).
- ••• menu "This book": Narrator for this book, Fix pronunciation, Go to position in book, Add to Up Next, Study guide (when tagged), Smart rewind for this book and Automatic cache for this book (Default / On / Off), About this book, Rebuild chapters and Start over when available.
- Preparation coverage counts actual numbered chapter entries (for authored chapters 2, 7 and 9, all ready is "3 of 3 chapters"). Authored gaps remain in position labels such as "Chapter 7 of 9".
- Preparing: the narration line expands to a card with progress and chapter counts, the live Pause/Resume, the ready stretch, and the explicit choice (Wait for the narrator, or Use instant narrator), 44px controls that wrap. Failed: a tinted card with a warning glyph and words ("Narration failed at chapter 13"), Retry and Use instant narrator; kept audio stays playable. Both sit between the narrator line and the chapter row and are inline status for toast suppression. The cover shrinks; transport does not move.
- Sheets: Speed has a large value, "9h 12m left in this book at this speed", a 0.05 stepper, presets 0.8 / 1.0 / 1.25 / 1.5 / 2.0, and "Applies to" This book / All books. Sleep lists durations and marks the chosen one with a check. Chapters + Bookmarks is one sheet with a two-way segmented control; the playing chapter says "Now playing". Recent lists the last five books (title, "Ch 4 · 08:51 · 6h 02m left"); the playing one is marked in words; a tap switches and resumes with no confirmation.
- Find: one tab. Source chips are toggles with a check when on. Results show format, size, year, and source in words, with a 44px Add button. Upload a file stays reachable. Loading, empty, failure, and needs-settings states use an icon, a plain sentence, and one action.
- Settings: a hub with one page per section (`#/settings/playback`, `#/settings/voice`, …). Sections: Listening, Library, Devices and integrations, Admin. Hub rows show the current value. Phones swap hub and page; 760px and wider show them side by side. Admin-only pages are omitted at render time. Pages use inset grouped cards with 56px rows. Voice creation is a disclosure, separate from choosing a narrator. Smart rewind and Automatic chapter cache live in Settings › Playback.
- Narrator cards use native selection buttons, with Preview and Save as separate controls. Model and Language stay visible, with presets US deep male, English voices, All voices. Start with US deep male and remember filters on this device. Gender, accent, and tone sit under More filters. The selected default stays visible outside filtered results. The US deep male preset also lists English male Nano voices in a separate, labelled group; upstream does not rate them, so keep them distinct and never hide them. Audio Activity lists paused and failed preparation jobs with narrator, ready time, and Pause/Resume.
- Up Next remains visible in the desktop library when the queue has books. It shows the queue order, Auto-continue, and move/remove controls. The docked player also shows a compact Up Next list with one-tap playback.
- Desktop docking: at 1200px and wider the player is a 400px right pane beside the library table, which narrows; the sort line moves under the title. Toasts centre on the library column. At 760-1199px the player is one column beside the sidebar.
- Composition files: `shell.css`, `player.css`, `sheets.css`, `settings.css`, `find.css`, `library-composition.css`. All are versioned in the offline app shell.
