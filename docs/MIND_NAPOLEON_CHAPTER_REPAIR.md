# Mind of Napoleon chapter repair

## Problem and correction

The EPUB for J. Christopher Herold's *Mind of Napoleon* has nested contents entries. Extraction discarded their levels and accumulated unrelated divider titles. A late chapter label therefore included nearly every earlier section. Introduction subsections and source-note subsections also lost their semantic context.

Use explicit TOC ancestors when the EPUB supplies a hierarchy. Keep the existing structural heuristics for flat TOCs. Classify introduction and back-matter descendants from their authored ancestors. Cache version 29 refreshes previously extracted EPUB chapter lists.

## Existing books and listening state

A label/type change changes the chapter structure key. Preserve audio, measured durations, positions, and bookmarks only when the retained import chapter list matches the stored structure key and every chapter's text is identical at the same index. Persist a metadata-only transition for writes from devices using the previous key. The pending reconciliation record also supplies that transition until separate persistence completes. Retry interrupted reconciliation on the next read.

If that proof is absent or narration changes, retain the existing conservative invalidation path. The historical import snapshot is not rewritten. A future parser change after this relabel may therefore need a new current baseline to preserve state again.

## Evidence

- Target book: `160bc5`, 190 sections before and after.
- Stored catalog, imported extraction, and cached extraction agree on the old structure key.
- All 190 section texts and estimated durations are identical after repair.
- Synthetic EPUB regression covers sibling sections, nested repeated labels, unique Roman introduction subsections, and source notes without copying book prose.
- Lifecycle regressions cover exact position/chunk preservation, bookmarks, audio state, old-device writes during interrupted persistence, refresh, and rejection of unproven/changed narration.

## Independent review

Independent reviewer in a fresh context.

- Accepted-verified: metadata refresh still reset `chapter1Ready` and `preloadedThrough`. Move those fields into the actual structure-reset branch and test preservation during relabeling.
- Judgment-call: retain conservative invalidation when the historical baseline cannot prove identity. Do not introduce a second cache-based proof mechanism in this repair.
- Accepted-verified: relabeling must only stamp records carrying the certified previous structure key. Keep older and unversioned positions/bookmarks stale; test both paths.
- Accepted-verified: shared metadata normalization reclassified short source-note headings after extraction. Preserve explicit hierarchical TOC front/back-matter metadata through normalization, and run the fixture through the complete document pipeline with short note sections.
- Amended full document pipeline verified on the target EPUB: 190 identical chapter texts and durations, including all short source-note labels.

Final independent verdict: ship. The reviewer verified the amended full pipeline and found no remaining blocker.
