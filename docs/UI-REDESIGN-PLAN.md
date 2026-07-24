# Xandrio UI Redesign Plan

> Historical note: this plan was absorbed by the 2026-07 overhaul and is kept as historical context, not the current implementation plan.

## Inspired by Libby + Hoopla

Reference: Libby (OverDrive) and Hoopla audiobook players — premium, content-focused, minimal chrome.

---

## Design Principles

1. **Cover art is king** — the book cover dominates the player screen
2. **Pure black OLED** — #000000 background, content floats on darkness
3. **Minimal chrome** — controls are transparent/borderless, fade into background
4. **Blurred cover background** (Hoopla-style) — optional ambient color behind cover for warmth
5. **Content hierarchy**: Cover → Title → Progress → Controls → Chapter
6. **Consistent touch targets** — 44px minimum, generous spacing
7. **No emoji icons** — SVG Heroicons exclusively

---

## Phase 1: Player View Overhaul ✅ (Done)

### Layout (top to bottom)
- [x] **Top bar**: Back arrow (left), speed + sleep timer (right) — transparent buttons
- [x] **Cover art**: Large, centered, ~300px wide, 2:3 aspect ratio, drop shadow
- [x] **Title + Author**: Centered below cover, clean typography
- [x] **Chapter title**: Subtle, secondary color
- [x] **Progress bar**: Thin scrubber, split time display (current / total)
- [x] **Main controls**: prev-chapter | skip-15s-back | PLAY | skip-15s-fwd | next-chapter
- [x] **Secondary**: Chapter select pill
- [x] **About this book**: Expandable details section

---

## Phase 2: Player Polish

### 2a. Blurred Cover Background (Hoopla-style)
- Extract dominant color from cover image (canvas sampling or CSS blur)
- Apply as subtle radial gradient behind cover art
- Implementation: CSS `backdrop-filter` or a hidden `<canvas>` that samples the cover
- Fallback: Pure black (current) — graceful degradation
- **Priority**: MEDIUM — nice visual touch, not blocking

### 2b. Progress Bar Enhancements
- [ ] **Book-level progress**: Show "X% of book complete" below chapter progress
- [ ] **Chapter/Book toggle**: Hoopla shows toggle between chapter progress and book progress
- [ ] **Thicker progress track on hover/drag** (desktop) — subtle feedback
- [ ] Remaining time display: "-X:XX" format option

### 2c. Control Refinements
- [ ] **Play button**: White filled circle with black icon (current ✅)
- [ ] **Skip buttons**: Show "15" label centered on rewind/forward arrows (current ✅)
- [ ] **Chapter nav**: Smaller, muted color (current ✅)
- [ ] **Haptic feedback**: On play/pause, skip, chapter change (navigator.vibrate)
- [ ] **Button press animation**: Scale down to 0.9 on :active (current ✅)

### 2d. Chapter Navigation
- [ ] **Swipe left/right on cover** to change chapters (gesture)
- [ ] **Chapter list drawer**: Tap chapter title to open full chapter list (bottom sheet)
- [ ] Chapter list shows: title, duration estimate, current marker
- [ ] **Auto-scroll** to current chapter in list

### 2e. Sleep Timer Visual
- [ ] When timer active: moon icon glows/pulses subtly
- [ ] Countdown shown as small text near moon icon
- [ ] Timer expiration: gentle fade-out (last 30s) — ✅ already implemented in JS

---

## Phase 3: Library View Refinements

### 3a. Book Cards
- [x] Loading spinner on tap
- [ ] **Reading progress bar**: Thin gold bar at bottom of card showing % complete
- [ ] **Last read time**: "2 hours ago" under author name
- [ ] Cover image placeholder: Book icon + title initials when no cover

### 3b. Grid View
- [ ] **Larger covers in grid**: 3 columns on phone, covers fill most of the card
- [ ] Title below cover, 1 line max with ellipsis
- [ ] No author in grid view (save space)
- [ ] Progress bar overlay on cover bottom edge

### 3c. Library Header
- [x] Collapsible search bar
- [x] Sort dropdown
- [x] Grid/list toggle
- [ ] **Pull-to-refresh** for library reload

---

## Phase 4: Search & Download View

### 4a. Search Results
- [x] Best match highlighted with gold border
- [x] Format badges (EPUB/MOBI/PDF)
- [ ] **Cover thumbnails** in search results (fetch from Open Library)
- [ ] **Loading skeleton** while search is in progress (instead of "Searching..." text)

### 4b. Download Progress
- [ ] **Real-time download progress** (currently shows generic "Downloading...")
- [ ] Show: downloading → validating → extracting metadata → pre-generating audio
- [ ] Animated progress steps with checkmarks

---

## Phase 5: Micro-Interactions & Polish

### 5a. Animations
- [x] Cover fade-in on player open
- [ ] **View transitions**: Slide left/right between library ↔ player
- [ ] **Chapter change**: Subtle cross-fade on chapter title
- [ ] **Progress saved**: Brief toast or subtle glow on position save

### 5b. Accessibility
- [x] All buttons have aria-labels
- [x] Focus-visible outlines
- [x] Screen reader announcements (speed change)
- [ ] **Keyboard shortcuts**: Space = play/pause, ←/→ = skip, ↑/↓ = chapter
- [ ] **High contrast mode** detection

### 5c. PWA Enhancements
- [x] apple-mobile-web-app-capable
- [ ] **Service worker** for offline cached audio
- [ ] **Media Session API**: Lock screen controls, now playing info
- [ ] **Background audio**: Keep playing when screen locks

---

## Color Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#000000` | Pure OLED black background |
| `--surface` | `#1A1A1A` | Cards, inputs, elevated surfaces |
| `--surface-hover` | `#252525` | Hover state for surfaces |
| `--border` | `#2A2A2A` | Subtle borders |
| `--text` | `#FFFFFF` | Primary text |
| `--text-secondary` | `#999999` | Author, chapter title |
| `--text-muted` | `#666666` | Timestamps, metadata |
| `--accent` | `#D4AF37` | Gold CTA, active states |
| `--danger` | `#DC2626` | Delete, errors |
| `--success` | `#16A34A` | Continue reading badge |

---

## Typography

- **Font**: Inter (Google Fonts)
- **Weights**: 400 (body), 500 (labels), 600 (titles), 700 (headings)
- **Player title**: 20px / 700
- **Player author**: 14px / 400 / text-secondary
- **Chapter title**: 14px / 500 / text-secondary
- **Timestamps**: 12px / tabular-nums
- **Card title**: 16px / 600
- **Card author**: 13px / 400

---

## Implementation Priority

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1 | ✅ Player layout overhaul | Large | Critical |
| 2 | Book progress bar on cards | Small | High |
| 3 | Media Session API (lock screen) | Medium | High |
| 4 | Chapter list drawer (bottom sheet) | Medium | High |
| 5 | Blurred cover background | Small | Medium |
| 6 | Keyboard shortcuts | Small | Medium |
| 7 | View transitions (slide) | Medium | Medium |
| 8 | Cover thumbnails in search | Small | Low |
| 9 | Download progress steps | Medium | Low |
| 10 | Service worker (offline) | Large | Low |

---

*Created: 2026-02-06*
*Last updated: 2026-02-06*
