---
target: UI feels stuck on
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-09-05T04-20-26Z
slug: public-index-html
---
Method: dual independent assessments (A: ui_design_review, Sol; B: isolated Codex CLI, Terra), plus parent browser inspection.

# Xandrio UI composition review

The interface has a consistent palette but an inconsistent hierarchy. The book, playback controls, secondary tools, and operational status each appear to have been composed separately. The next pass should reorganize the player and library around listening, keeping the existing dark palette, gold accent, covers, and accessible controls.

## Priority improvements

1. **P1 — Compose the player as one listening surface.** The current chapter is a large pill, appears again below the scrubber, and also has a Chapters utility. A large Chapter/Book selector sits above a scrubber while a second book-progress bar sits below it. The desktop chapter pill, voice pill, timeline, and transport use different widths. Use one shared alignment; place title/author, chapter row, timeline, and transport in that order. Keep book progress as a quiet text summary and retain book-wide seeking through a compact scope control. Keep chapter navigation in one visible location. Sources: public/index.html:873, public/index.html:937, public/index.html:981.

2. **P1 — Give playback status a stable place.** Voice, premium preparation, loading, recovery, and resume currently use separate visual forms. Consolidate presentation into one status area close to the timeline, with one relevant action and details on demand. Preserve all recovery behavior. On mobile, the flattened columns assign explicit order to most elements but omit HQ preparation, reliability, and resume; these can precede the cover when shown. Fix the ordering explicitly. Sources: public/index.html:893, public/style-v3.css:3077.

3. **P2 — Make the library easier to scan.** A portrait Continue Listening card occupies substantial mobile space before sorting and the main list, where the same title appears again. Desktop dedicates a broad left rail to that small card. Use a compact horizontal resume card with cover, title, remaining time, and a clear Play action. Retain the title in the complete library, but reduce the visual repetition. Integrate download status/actions into the row instead of reserving a separate tall band. Sources: public/index.html:103, public/style-v3.css:353, public/style-v3.css:5843.

4. **P2 — Reduce competing navigation and chrome.** Stats, Settings, Filter, and Add are large header controls above a second navigation row. Separate primary library tasks from occasional account/admin tasks. Use common control sizes, border weights, and spacing. Preserve 44px hit targets while reducing visible boxes. A clear Library/Find books navigation structure and an unobtrusive secondary menu would make the app feel less like a toolbar collection. Sources: public/index.html:47, public/style-v3.css:3212.

5. **P2 — Group settings by user task.** Sources, account, sync, integrations, diagnostics, caching, playback, voices, and language live in one accordion sequence. Use Listening, Voices, Library & Sources, and Server & Account groups. In voice selection, the large gold cloning form competes with choosing a narrator. Move creation behind a Create voice action; preserve its consent and upload flow in the resulting sheet. Sources: public/index.html:341, public/index.html:448, public/index.html:644.

Search source inspection suggests the same hierarchy issue: the large upload block competes with finding books. Make Upload an explicit secondary acquisition path. Search result screenshots could not be verified, so this is a source-based recommendation, not a rendered finding.

## What to retain

The restrained dark/gold palette, recognizable covers, prominent central Play control, labeled mobile utilities, and existing sheet/focus behavior are useful foundations. No wholesale visual rebrand is needed.

## Heuristic assessment

These are qualitative design judgments, not usability-test measurements.

| Heuristic | Score / 4 | Evidence |
|---|---:|---|
| Visibility of system status | 2 | Many signals, fragmented placement |
| Match with the real world | 3 | Books and chapters are clear; engine details intrude |
| User control and freedom | 3 | Seek, dismissible sheets, and explicit resume controls |
| Consistency and standards | 2 | Multiple control and status treatments |
| Error prevention | 3 | Existing disabled states and deliberate actions |
| Recognition rather than recall | 3 | Labeled mobile tools; desktop relies more on icons |
| Flexibility and efficiency | 2 | Sparse library rows and repeated chapter access |
| Aesthetic and minimalist design | 1 | Independent bands compete for attention |
| Error recovery | 3 | Explicit retry/resume actions; placement needs work |
| Help and documentation | 3 | Contextual explanations exist but can overwhelm |
| Total | 25 / 40 | Functional foundation; composition needs consolidation |

## User impact

A returning mobile listener must scan past library chrome and repeated content to resume or choose a title. A new user selecting a voice encounters voice creation before a concise narrator choice. A desktop listener sees related player controls with several separate alignment lines. These are hierarchy problems rather than missing features.

## Detector and evidence

The isolated detector reported 13 warnings: two guide-related side borders, one Inter-font warning, and ten width transitions. These do not explain the central composition issue; changing fonts or animations first would miss the larger opportunity. Browser review covered populated mobile and desktop library, player, and settings/voice scenarios. Colored blank covers are deliberate fixture assets. Five search capture variants failed their expected-results signature and were not used as visual evidence. No live overlay was injected. Scenario environments closed after capture.

## Suggested sequence

First compose the player and its transient states. Then simplify Continue Listening and library rows. Finally normalize shared controls and regroup settings. Verify mobile normal, long-title, buffering, offline, and resume states as part of that work.

Questions skipped: the requested review has a clear first priority, and no product decision is required to state the findings. Application code is unchanged.
