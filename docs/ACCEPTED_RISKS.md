# Accepted risk register

Status: no risks are accepted for v1.1.0. Open entries below block release
unless the project owner changes their status with dated evidence and an expiry.

| ID | Risk | Status | Impact | Mitigation or exit criterion | Owner | Review due | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-01 | Tracked binary, font, icon, and audio assets lack complete redistribution evidence. | Closed 2026-07-23 | Public distribution may infringe rights or violate terms. | Clear every row in `ASSET_PROVENANCE.md` or approve a history-rewrite plan. | Project owner | Before tag | `RELEASE_APPROVALS.md`: every `ASSET_PROVENANCE.md` row cleared 2026-07-15 and 2026-07-23 |
| R-02 | The private legacy repository contains a historical Anna credential that cannot be rotated or revoked through the provider. | Closed 2026-07-23 | Publishing legacy history would permanently disclose an active credential. | Do not publish or make the legacy repository public. Create a sanitized public root commit, verify every public ref with Gitleaks, and restrict/archive the legacy repository. | Security maintainer | Before tag | `RELEASE_APPROVALS.md`: sanitized single-commit public root pushed to `ProofOfReach/xandrio` with a zero-finding full-ref Gitleaks scan on 2026-07-23; legacy repository stays private |
| R-03 | Edge TTS and live acquisition provider behavior depend on third parties. | Open — release blocking | Availability, terms, and behavior may change after tests. | Record live compatibility evidence and current reviewer decision; retain local/upload paths. | Provider and TTS maintainers | Before tag, then monthly | Pending |
| R-04 | Public OCI image security has no exact published digest yet. | Open — release blocking | Scan and provenance claims would be unverified. | Produce the candidate digest and complete `CURRENT_IMAGE_SECURITY.md`. | Security maintainer | Before promotion | Pending |
| R-05 | LAN and remote-route evidence is not recorded. | Open — release blocking | Self-hosted deployment failures could reach first users. | Pass LAN-01 and NET-01 against the immutable candidate in `RELEASE_TEST_MATRIX.md`. | Deployment owner | Before promotion | IOS-01 passed by owner on 2026-08-29 (`IPHONE-TEST.md`); UMB-01 removed with Umbrel packaging on 2026-08-29 |

An accepted risk must include the decision maker, date, scope, mitigation,
operator disclosure, review date, and expiry. It expires automatically on its
review date. Critical vulnerabilities, missing asset rights, unrepaired secrets,
and an unapproved release candidate are never acceptable waivers.
