---
target: Nano voices and background preparation UX/UI
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-10-02T15-12-18Z
slug: public-js-views-voices-js
---
Method: dual-agent (A: /root/nano_ui_design_review · B: /root/nano_ui_evidence_review)

**Verdict:** Keep Xandrio’s visual identity. The preparation workflow needs clearer promises and better control before it supports dependable long listening sessions.

**Design health — 21/40: significant improvements needed.** These are heuristic judgments, not usability-test results.

| Heuristic | Score / 4 | Main gap |
|---|---:|---|
| System status | 2 | Chapters ready does not show uninterrupted listening time. |
| Real-world language | 2 | Engine and tier labels obscure what the reader will hear. |
| Control and freedom | 2 | No Nano-job pause or explicit fallback choice. |
| Consistency | 3 | Player and queue describe preparation differently. |
| Error prevention | 2 | Global narrator changes have unclear scope. |
| Recognition over recall | 2 | Readiness must be pieced together across screens. |
| Efficiency | 2 | Favorites and search help; book-specific jobs are missing. |
| Minimal design | 3 | Calm player, dense Settings catalog. |
| Error recovery | 2 | Retry exists; delayed and stale states need work. |
| Contextual help | 1 | Waiting and narrator changes lack explanation when choosing. |
| **Total** | **21/40** | **Acceptable, with material workflow gaps.** |

**Design specificity and strengths.** The cover-first player, restrained colors, and prominent transport belong to Xandrio. Keep them. The narrator sheet usefully pins the current voice and supports previews, search, and saved voices. Dialog focus and dismissal work. Audio Activity already supports queue ordering; download and offline-preparation rows already have Cancel. No horizontal overflow appeared at desktop, 390 px, or 320 px.

**Five priorities**

1. **P1 — Identify the voice actually playing.** During instant fallback, the status still leads with the selected Nano narrator’s name. Show “Playing: Adam · Nathan preparing,” and offer “Play with Adam” or “Wait for Nathan” when Nathan is unavailable. This is a narrator change, not merely a quality setting. [Status rendering](/Users/k/.codex/worktrees/moss-nano-voices/alexandrio/public/js/views/voices.js:551). Suggested command: `$impeccable clarify`.

2. **P1 — Show uninterrupted listening time.** The controlled fixture reached **7/8 chapters ready while chapter two remained unavailable**. Whole-book percentage can therefore conceal the next gap. Lead with “Nathan ready for the next N minutes,” calculated from the current position at the selected speed. Keep whole-book progress secondary. Show an estimated wait only when measured throughput supports it. [Preparation panel](/Users/k/.codex/worktrees/moss-nano-voices/alexandrio/public/js/views/voices.js:598). Suggested command: `$impeccable shape`.

3. **P1 — Make narrator selection accessible.** Keyboard focus reaches Save and Preview but cannot select a voice. Use native radio controls or selection buttons, with Save and Preview separate. This affects both pickers. [Voice cards](/Users/k/.codex/worktrees/moss-nano-voices/alexandrio/public/js/views/voices.js:794). Suggested command: `$impeccable harden`.

4. **P2 — Make preparation a clear book-specific job.** Voice selection currently changes one global preference. Label that scope now. The larger improvement is a narrator attached to each book’s preparation job, with Pause/Resume and the same readiness information in Audio Activity. Preserve existing ordering and Cancel controls. Scheduling can follow later. [Global selection](/Users/k/.codex/worktrees/moss-nano-voices/alexandrio/lib/routes/preferences-routes.js:378), [activity rows](/Users/k/.codex/worktrees/moss-nano-voices/alexandrio/public/js/features/queue-status.js:262). Suggested command: `$impeccable shape`.

5. **P2 — Fix phone status and touch targets.** Preparation text truncates at 390 px. Retry/Prepare is 30 px high; other filters measure 24–38 px, below the project’s 45 px target. Let status copy wrap and enlarge interactive areas. [Preparation styles](/Users/k/.codex/worktrees/moss-nano-voices/alexandrio/public/style-v3.css:2545). Suggested command: `$impeccable adapt`.

**Cognitive load and emotional journey.** Settings fails four checklist items: chunking, minimal choices, working memory, and progressive disclosure. Five featured voices, a long catalog, and four filters compete before the reader understands the wait. Keep the full catalog available behind a simpler listening-oriented first choice. The player starts confidently; uncertainty begins when “ready” fails to answer how long the chosen narrator can continue.

**Persona checks.** A first-time listener can mistake the selected narrator for the audible narrator. A keyboard-only reader cannot select a voice. A phone commuter cannot judge whether enough uninterrupted audio is ready for a journey.

**Minor observations.** The initial preparation poll briefly shows “Not started” and an enabled Prepare button before the real state arrives. Use “Checking preparation…” until confirmed. Open the voice sheet immediately with a scoped loading state; its current silent wait can resemble a missed tap. Keep unknown or stale status distinct from idle.

**Detector and evidence.** The deterministic scan returned zero findings in `public/index.html`, `public/js/views/voices.js`, and `public/js/features/queue-status.js`. Manual browser and source review found the workflow and accessibility problems above; a clean detector result is not a usability pass. Checks used the real app with synthetic books and stubbed speech. The held chapter deliberately produced the preparation failure; this was not evidence of a production synthesis regression. The fixture was added to its user shelf before assessing Audio Activity, which then displayed the active chapter correctly. No reliable overlay was available because native browser evaluation is read-only. Screens were inspected directly instead. Accessibility review also used the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

**Recommended sequence:** fix narrator labels, keyboard selection, and phone controls; then design time-based readiness and fallback choice; then add book-specific preparation jobs and Pause/Resume. Finish with `$impeccable polish`. These are recommendations, not implemented changes.

Questions skipped: the immediate priorities follow directly from listening reliability and accessibility. For the later workflow design, the recommended default is a narrator per book with an optional library default.
