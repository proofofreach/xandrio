# Release candidate report template

Status: not a candidate — publication blocked
Candidate tag: pending
Commit: pending
OCI digest: pending
Prepared by: pending
Reviewed by: pending
Date: pending

This is the source-controlled report format. The release workflow writes
`CANDIDATE_EVIDENCE.md`, fills automatic gates from the exact run, and attaches
it as an artifact. Reviewers record remaining manual results while the
protected `release` environment waits. A generic “workflow passed” claim is
insufficient: each gate needs its own result and evidence.

| Gate | Status | Evidence | Owner | Review date |
| --- | --- | --- | --- | --- |
| Signed tag and exact commit | Pending | Tag verification URL and commit SHA | Release owner | Pending |
| Source tests, browser smoke, calibrated audio | Pending | Workflow job and artifact URLs | QA owner | Pending |
| History scan, asset provenance, licence notices, audit, SBOM | Pending | Workflow job and artifact URLs | Security owner | Pending |
| Optional-engine builds and scans | Pending | Per-engine jobs, digest, and scan output | TTS owner | Pending |
| Multi-architecture image | Pending | Digest, amd64 and arm64 logs | Packaging owner | Pending |
| Restart persistence | Pending | Fixture checksum and run log | Packaging owner | Pending |
| Upgrade/rollback or FIRST-01 backup/restore | Pending | Matrix row DATA-02 or FIRST-01 evidence | Release owner | Pending |
| Exact-digest security scan, provenance, signature, anonymous pull | Pending | Scan, attestation, signature, and pull URLs | Security owner | Pending |
| Digest-pinned Umbrel bundle | Pending | Rendered artifact checksum | Umbrel maintainer | Pending |
| Safari/iOS, LAN, remote route, and Umbrel manual checks | Pending | Matrix rows IOS-01, LAN-01, NET-01, UMB-01 | QA and deployment owners | Pending |
| Formats, engines, and live-provider checks | Pending | Matrix rows FMT-01 through PROV-02 | Import, TTS, and provider owners | Pending |
| Open risks and accepted risks | Pending | `ACCEPTED_RISKS.md` review reference | Project owner | Pending |

## Exceptions

List each non-pass result with the gate ID, impact, mitigation, expiry, named
owner, and an explicit project-owner decision. Do not use this section to
override a non-waivable blocking gate.

None recorded.

## Promotion decision

Promotion remains blocked until every blocking release-matrix row passes,
`docs/RELEASE_APPROVALS.md` is complete, and the project owner approves the
protected GitHub `release` environment for this exact commit and digest. The
approval record must link the completed candidate evidence; the immutable tag
cannot be edited to claim results that only exist after its image is built.
