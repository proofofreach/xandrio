---
target: Xandrio WS-01 visual foundations
total_score: 79
max_score: 100
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-08-22T05-06-33Z
slug: public-index-html
---
# WS-01 visual-foundation critique

Score: **79/100 — fail**. P0: 0. P1: 1. The mobile player is strong; the responsive app shell is not yet competitive.

## Evidence and independence

Two fresh critics independently inspected the running scenario product at 390×844 and 1440×900. Assessment A reviewed 29 rendered states across library, search, Guide, player and sheets, Settings, Stats, offline, degraded, and error paths. Assessment B separately ran the Impeccable detector once and measured rendered typography, contrast, targets, focus, reduced motion, overflow, and sheet focus return. Neither critic edited the product or relied on a builder summary.

## Visual-foundation heuristics

| Foundation | Score | Evidence |
|---|---:|---|
| Typography | 7/10 | Clear Inter hierarchy, but repeated 10–12px muted labels reduce comfort; Settings helper text measured 4.08:1 contrast. |
| Hierarchy | 9/10 | Mobile player establishes an excellent cover, title, chapter, progress, and controls sequence. |
| Spacing | 8/10 | Mobile rhythm is disciplined; desktop search and Stats leave large unmanaged voids. |
| Color | 9/10 | Restrained near-black surfaces and warm gold accent are coherent and recognizable. |
| Elevation | 8/10 | Sheets use convincing dimming, borders, handles, and shadows; base cards can feel flat. |
| Navigation coherence | 6/10 | Shelf tabs, icon-only global controls, back links, and player utilities form competing models. |
| Motion and feedback | 9/10 | Route and sheet feedback is strong and reduced-motion computed durations collapse to 0.01ms. |
| Responsive consistency | 7/10 | Player adapts well; offline feedback collides with the mobile header, while desktop surfaces remain mobile-width. |

## Specificity and cognitive load

The player feels authored for Xandrio through narration readiness, chapter/book progress, voice switching, pronunciation repair, Book Guide, and offline-aware feedback. Library, search, Stats, and Settings are more interchangeable. Settings exposes too many simultaneous choices: the live document contained 115 interactive controls, with 86 actions in the Voice surface.

## Emotional journey

Library opens calm and purposeful. The player is the emotional peak. Chapters, speed, and sleep sheets preserve confidence. Voice selection becomes a long utilitarian valley. Error recovery is strong, but the mobile offline banner damages the header. Desktop Stats ends cleanly but flatly.

## Strengths

- The 390px player is cover-led, focused, thumb-friendly, and competitive.
- Sheets are consistent, legible, and preserve place; Escape returns focus correctly.
- Error, empty, offline, active, and narration-readiness states use one coherent token system.
- Sampled states had no horizontal overflow; standard controls generally met the 44px floor.

## Priority issues

1. **[P1] Offline feedback obscures mobile global navigation.** The fixed banner covers the upper logo and header controls at 390×844, precisely when downloaded-content navigation matters. Reserve space or place it below the header and safe-area inset.
2. **[P1] Settings helper text fails normal-text contrast.** An independently measured 11px helper style has 4.08:1 contrast against the background, below WCAG AA. Raise its contrast and establish a safer microtype floor.
3. **[P2] Desktop is enlarged mobile layout.** Library, search, and Stats leave large dead regions rather than using desktop-specific density or composition.
4. **[P2] Global navigation lacks one learned model.** Shelf tabs, icon-only Stats/Settings/Search, text back links, and player utilities compete.
5. **[P2] Continue Listening dismiss target is 26×26px.** Expand the hit area to at least 44×44px without enlarging the glyph.
6. **[P2] Three empty image sources are fragile template state.** They are hidden or replaced in populated rendering, but should be omitted until populated.
7. **[P3] A visible emoji Voice cloning badge violates the documented no-emoji visual language.**

## Persona red flags

- **Casey, distracted mobile listener:** the player works one-handed, but the offline banner blocks top-level controls and Voice becomes a long scrolling task.
- **Jordan, first-timer:** search and playback are clear; unlabeled global icons and split navigation make orientation less obvious.
- **Alex, power listener:** player utilities are direct, but the long Voice catalogue and sparse desktop composition slow scanning.

## Reference limits

Comparison used accessible official public material for Audible, Apple Books, Libby, Spotify Audiobooks, and Speechify. Signed-in, entitled, purchased, paywalled, private, and native-only flows were not accessed. Browser evidence is Chromium, not a physical iPhone or installed PWA.

## Selected next action

The active Gauntlet contract already authorizes autonomous single-gap selection, so no user question is required. Fix the mobile offline-banner/header collision first, then rerun the focused live critic.
