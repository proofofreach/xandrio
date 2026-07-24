# Accepted risk register

Status: no risks are accepted for v1.1.0. Open entries below block release
unless the project owner changes their status with dated evidence and an expiry.

| ID | Risk | Status | Impact | Mitigation or exit criterion | Owner | Review due | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-01 | Tracked binary, font, icon, and audio assets lack complete redistribution evidence. | Open — release blocking | Public distribution may infringe rights or violate terms. | Clear every row in `ASSET_PROVENANCE.md` or approve a history-rewrite plan. | Project owner | Before tag | Pending |
| R-02 | The private legacy repository contains a historical Anna credential that cannot be rotated or revoked through the provider. | Open — release blocking | Publishing legacy history would permanently disclose an active credential. | Do not publish or make the legacy repository public. Create a sanitized public root commit, verify every public ref with Gitleaks, and restrict/archive the legacy repository. | Security maintainer | Before tag | Pending |
| R-03 | Edge TTS and live acquisition provider behavior depend on third parties. | Open — release blocking | Availability, terms, and behavior may change after tests. | Record live compatibility evidence and current reviewer decision; retain local/upload paths. | Provider and TTS maintainers | Before tag, then monthly | Pending |
| R-04 | Public OCI image security has no exact published digest yet. | Open — release blocking | Scan and provenance claims would be unverified. | Produce the candidate digest and complete `CURRENT_IMAGE_SECURITY.md`. | Security maintainer | Before promotion | Pending |
| R-05 | Safari/iOS, LAN, remote-route, and Umbrel evidence is not recorded. | Open — release blocking | Self-hosted deployment failures could reach first users. | Pass IOS-01, LAN-01, NET-01, and UMB-01 against the immutable candidate in `RELEASE_TEST_MATRIX.md`. | QA and deployment owners | Before promotion | Pending |

An accepted risk must include the decision maker, date, scope, mitigation,
operator disclosure, review date, and expiry. It expires automatically on its
review date. Critical vulnerabilities, missing asset rights, unrepaired secrets,
and an unapproved release candidate are never acceptable waivers.
