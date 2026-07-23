# Release asset provenance

This inventory covers non-code binary and generated-media assets in the Git
release archive. An entry marked **owner review required** blocks a public
release. Do not infer permission from the fact that an asset is already in Git.

| Asset | SHA-256 / identity | Current evidence | Release status |
| --- | --- | --- | --- |
| `public/fonts/inter-latin.woff2` | `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4` | Byte-for-byte match for the Google Fonts Inter v20 Latin variable WOFF2; exact URL, retrieval date, upstream project, and bundled OFL 1.1 text are recorded in `public/fonts/README.md` and `public/fonts/OFL.txt` | **Approved — verified 2026-07-15** |
| `alexandrio-xandrio/icon.png`, `public/icon-512.png` | `76991a705bf0ff22e8d879a1737590bfbac06e05e28ce8a9f309eb5fb85f6faf` | Same project-owned Xandrio artwork; introduced by project commit `342628e`. The project owner confirmed ownership and authorized public distribution, including the Umbrel-specific copy, during release review on 2026-07-15. | **Approved by project owner — 2026-07-15** |
| `public/icon.png` | `a9209f05156199d9b28da94d0a92a16b7d4d53401f918aa40380bedaf4d31f64` | Project-owned “Alexandrio logo V3”, introduced by project commit `1834e37`; ownership and public-distribution authority confirmed by the project owner on 2026-07-15. | **Approved by project owner — 2026-07-15** |
| `public/icon-xandrio-ankh.png` | `0208d7546efc63101550682f3486cdf6b6e8f157d6e9c52b67b88d40780c0418` | Project-owned Xandrio artwork introduced by project commit `4798f41`; ownership and public-distribution authority confirmed by the project owner on 2026-07-15. | **Approved by project owner — 2026-07-15** |
| `public/icon-192.png` | `e21ae477d1f00557abc0f1df503367625c65e8f209a58ceaff85faa0ce164a55` | Project-owned Xandrio icon derivative introduced by project commit `4798f41`; ownership and public-distribution authority confirmed by the project owner on 2026-07-15. | **Approved by project owner — 2026-07-15** |
| `public/apple-touch-icon.png` | `25c8c03f0a6dbc51900ea55fc14f1c080af8a638a42e0db25844a77023a089fb` | Project-owned Xandrio icon derivative introduced by project commit `4798f41`; ownership and public-distribution authority confirmed by the project owner on 2026-07-15. | **Approved by project owner — 2026-07-15** |
| `public/tts-comparison.html`, `public/tts-comparison-moss.html` | Generated HTML containing twelve embedded audio data URIs; current files are about 1.3 MB and 3.1 MB | Introduced by project commit `4798f41`; the project owner confirmed the embedded comparison assets are cleared for public distribution during release review on 2026-07-15. | **Approved by project owner — 2026-07-15** |
| `tts-benchmark-samples/chatterbox-original.wav`, `tts-benchmark-samples/edge-andrew-reference.mp3`, `tts-benchmark-samples/kokoro-af-heart.wav` | Three tracked calibration/reference samples | Introduced by project commit `4798f41`; generated locally by the project's own Chatterbox, Edge, and Kokoro engine paths as calibration fixtures; the project owner reviewed the group and authorized public distribution on 2026-07-23 | **Approved by project owner — 2026-07-23** |

Before changing a status to approved, record the creator or upstream URL and
version, applicable licence/terms, who confirmed the rights, and the date. If
an asset cannot be cleared, prepare a removal and Git-history rewrite proposal;
execute it only with project-owner approval because it changes existing clones
and tags.
