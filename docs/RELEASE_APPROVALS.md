# v1.1.0 release approvals

The signed release tag may be created only after the project owner records each
decision below with a link, date, or named reviewer. These are distribution
decisions; an end-user acknowledgement cannot replace them.

- [x] Project owner approved v1.1.0 scope, known limitations, and release notes. Evidence: owner approval recorded in the release working session on 2026-07-23.
- [x] Contribution ownership and the right to publish the complete retained Git history under MIT were confirmed. Evidence: current author inventory is ProofOfReach (45 commits), FamBot at `proofofreach.com` (26), FamBot at Gmail (9), plus Claude model co-author trailers; the project owner confirmed on 2026-07-23 that all listed identities are the owner's own accounts and that publication rights under MIT are held. The public repository begins from a sanitized one-commit root, so the retained history itself is not published.
- [x] The non-rotatable historical Anna credential is excluded from publication: create the public repository from a sanitized root commit, keep the legacy repository private, and pass Gitleaks against every public ref before release. Evidence: provider-side replacement/revocation is unavailable; the legacy repository `alexandrio` stays private; on 2026-07-23 the owner-approved `release:prepare-public-root` produced a single-commit sanitized root whose full-ref Gitleaks scan passed with zero findings, and only that root was pushed to `ProofOfReach/xandrio`.
- [x] Every entry in `docs/ASSET_PROVENANCE.md` was cleared or handled under an owner-approved history plan. Evidence: the exact Inter v20 artifact and OFL notice were cleared on 2026-07-15; the project owner confirmed all Xandrio icon variants, Umbrel icon use, and embedded TTS comparison assets are cleared for public distribution on 2026-07-15; the project owner approved the remaining `tts-benchmark-samples/` calibration/reference group for public distribution on 2026-07-23.
- [x] Targeted counsel review covered distribution and promotion of the acquisition connectors, Edge TTS integration, voice references, and selected release jurisdictions. Evidence: the project owner recorded approval of this gate on 2026-07-23.
- [x] Confirm `security@xandrio.xyz` and `conduct@xandrio.xyz` are monitored and test delivery before release. Evidence: the published contact domain changed from `xandrioplayer.com` to `xandrio.xyz` on 2026-07-23; the domain was registered at Porkbun, forwarding for both addresses was configured by the owner, and `check-release-contacts` passed (2 MX records, SPF present) on 2026-07-23; the project owner confirmed end-to-end delivery of the test messages to both mailboxes on 2026-07-23.
- [x] The public repository, protected default branch, protected `release` environment, signed-tag policy, public GHCR package, and release authority were configured and tested. Evidence: on 2026-07-23 `ProofOfReach/xandrio` was created public with read-only default Actions workflow permissions, Actions blocked from approving pull requests, and a `release` environment requiring reviewer `proofofreach` with self-review prevented; after the sanitized push, `main` branch protection (enforce-admins, strict `verify`+`dependency-review` checks, required CODEOWNER review with stale-dismissal, conversation resolution, no force-push/deletion) was applied and `npm run check:public-repository` passed. The signed-tag policy and public GHCR package are exercised by the tagged release-candidate workflow, which remains gated behind the protected `release` environment and is not part of this source-publication step.

Checking a box without evidence is not approval. Any feature removal or material
provider/TTS replacement still requires its own owner review.

After these source-controlled approvals pass, the workflow builds and tests an immutable candidate digest and uploads `CANDIDATE_EVIDENCE.md`. The project owner must review that report and approve the protected GitHub `release` environment before the workflow can promote `stable` or publish the GitHub release. This final environment approval is the candidate-report approval; it cannot be recorded truthfully before the candidate exists.

The candidate is also blocked until every `Blocking` row in
[`RELEASE_TEST_MATRIX.md`](RELEASE_TEST_MATRIX.md) is `Pass` with dated
evidence. The tagged file defines the gates; it cannot truthfully contain
results that only exist after the candidate is built. The workflow writes
automatic results to `CANDIDATE_EVIDENCE.md`, and reviewers complete the
remaining exact-digest/manual rows while promotion waits at the protected
`release` environment. Final environment approval is the enforcement point
and must link the completed evidence. Workflow success alone is insufficient.
