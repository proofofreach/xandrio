---
version: 1
slug: "public-js-views-player-ui-js"
primary_target: "public/js/views/player-ui.js"
related_targets: ["public/composition.css","public/index.html"]
---

# Player redesign

Mode: Operate. Scope: audiobook player, especially iPhone portrait.
Approved: option 1, `.impeccable/mocks/01-cover-first.png`. User said "1 is fine". The alternatives were too similar; do not repeat that selection exercise.

A listener uses this on the move or in low evening light. Keep the dark palette and existing Inter UI family. Lead with large, uncropped portrait artwork, then left-aligned title and author. A single chapter selector leads into chapter/book seeking and five transport controls. Book completion and changeable narration sit together below transport. Sleep, bookmark, speed and book details stay accessible.

Implementation inventory:
- Cover: existing real book image, intrinsic ratio, no square background or crop. The comp's generated cover lettering is not an asset.
- Type: HTML, 24px semibold title, 14px author, 14px chapter, 12px metadata. Long content may wrap.
- Controls: existing semantic buttons and SVG, 44px minimum hit areas, 72px round primary playback. No new ellipsis action from the comp.
- Timeline: native range, thin amber elapsed track and muted remaining track; chapter/book switches keep full touch targets.
- Layout: CSS, 24px phone gutters; artwork scales with viewport height, short screens scroll when necessary. Desktop retains two columns.
- Status: existing loading, recovery, preparation and error content between chapter and timeline, never concealed to fit.
- Finish: 4px cover corners, flat background, subtle offset cover shadow, quiet utility row; preserve reduced-motion behavior.

No unresolved design choices. Do not change playback engines or unrelated screens.
