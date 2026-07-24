# Release preflight — 2026-07-15

Status: source preflight passed; publication remains blocked

- Tested source commit: `9415990`
- Host: macOS arm64
- Node: `v26.0.0` (local preflight only; the supported release target is Node 24)
- npm: `11.14.1`

## Passing local evidence

| Check | Result |
| --- | --- |
| Unit/integration tests | 1,685 passed across 59 suites; 0 failed or skipped |
| Browser smoke | Passed playback, search, shell upgrade failure, PWA icons, offline, and Range handling |
| Calibrated audio | Edge, Kokoro, and Chatterbox fixtures passed loudness, peak, range, and duration checks |
| Release declarations | Consistent for `v1.1.0` |
| Docker Compose models | Standard and local-engine profiles validate |
| Docker build context | Passed with 289 effective files inspected |
| Production dependency audit | 0 reported vulnerabilities at the configured threshold |
| Dependency inventories | npm and four declared Python SBOMs generated successfully |
| Third-party notices | Regenerated from the locked tree with no Git diff |
| Static syntax | `server.js` and all JavaScript under `lib`, `scripts`, and `test` passed `node --check` |
| Sanitized-root tooling | One-commit export, dirty-source refusal, path safety, and all-ref scan invocation tests passed |
| Repository-control tooling | Public visibility, branch protection, release reviewers, and read-only Actions permission tests passed |

## Expected blocking results

| Check | Result |
| --- | --- |
| Legacy full-ref secret scan | Correctly rejected the private history with 4 findings |
| Asset provenance | 7 icon/audio groups still require owner review |
| Release approvals | 7 evidence-backed decisions remain unchecked |
| Published contacts | `xandrioplayer.com` mail DNS returned `ENOTFOUND` |
| Public repository controls | The legacy repository is private and correctly rejected as a release repository |
| Container image | Not built: Docker Desktop requires a local macOS administrator approval before its daemon starts |

This is not candidate evidence. The exact signed candidate must repeat the source
checks on Node 24 and complete the OCI, manual-device, provider, and deployment
rows in `docs/RELEASE_TEST_MATRIX.md`.
