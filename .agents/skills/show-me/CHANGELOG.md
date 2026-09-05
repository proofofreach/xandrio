# Changelog

| Date | Change | Why | Verification | Decision |
| --- | --- | --- | --- | --- |
| 2026-09-04 | Created the project-local `show-me` skill from the HumanLayer concept. Added evidence requirements, current/proposed labels, Xandrio behavior boundaries, temporary-artifact policy, and Codex-native HTML preview. | The upstream skill has a useful visual-selection rule but does not require code evidence and contains a Claude-specific `Bash(open ...)` step. | Structural validator passed. | Kept |
| 2026-09-04 | Bounded evidence gathering and required behavior-changing variants. Added the finite-media and Smart Rewind distinctions for Xandrio seeking. | The first fresh-context run searched too broadly and produced an incomplete media-boundary diagram. | Second fresh-context seeking scenario passed on content and read-only behavior. | Kept |
| 2026-09-04 | Prohibited repository-root content searches at the start of a behavior trace. | The second run produced a correct final answer but still spent 106,514 tokens on broad discovery. | Final wording passed a fresh `gpt-5.6-terra` run. The run obeyed the search restriction and passed 133 focused checks. Separate local suites passed 138 tests with no failures. | Kept |
