# Xandrio Open-Source Release Plan

Status: Implemented; external release approvals remain blocked
Prepared: 2026-07-12
Target: First public source and self-hosted distribution release

## 1. Objective

Release Xandrio as an MIT-licensed, self-hosted personal reading server that users operate on their own hardware and under their own applicable law. Publish the source repository, container image, and Umbrel package with enough security, provenance, documentation, and release automation for an unfamiliar operator to install and maintain it.

The release preserves all existing functionality. This includes every current acquisition provider, file format, TTS engine, voice feature, playback feature, offline feature, and sync feature.

## 2. Fixed decisions

These decisions govern every release task:

1. Xandrio is self-hosted software, not a hosted content or TTS service.
2. The project will not proxy, store, index, or process operators' books, credentials, generated audio, or provider requests on project-operated infrastructure.
3. Existing functionality will not be removed as part of release preparation.
4. A legal, licensing, terms, or security concern creates a review gate. It does not authorize feature deletion.
5. Allowed responses at a gate are: document the behavior, require explicit operator enablement, add a safer equivalent path, replace an implementation without losing capability, obtain qualified review, or delay the release.
6. Any proposed removal requires a separate, explicit decision by the project owner.
7. The MIT licence remains an OSI-compatible software licence without field-of-use restrictions. Responsible-use notices belong in documentation and product UI, not in the licence grant.
8. Xandrio will not claim that a source or use is legal or illegal in every jurisdiction. Operators must decide what their applicable law and provider agreements permit.

## 3. Release definition

The release is complete only when all of these artifacts refer to the same tested commit and version:

- Public GitHub source repository.
- Signed Git tag and GitHub release with release notes and checksums.
- Public multi-architecture GHCR image for `linux/amd64` and `linux/arm64`.
- Digest-pinned Umbrel manifest that installs anonymously.
- Native Node.js installation instructions.
- Docker and Docker Compose installation instructions.
- Security, privacy/data-flow, legal-use, contribution, and support documentation.
- Third-party licence and bundled-asset notices.
- Reproducible CI evidence for tests, dependency review, container scanning, and a clean-install smoke test.

## 4. Current baseline

| Area | Current state | Release consequence |
| --- | --- | --- |
| Repository | GitHub repository is private; the release branch is clean and the product and release-tooling batches are committed | Keep the legacy repository private; review the sanitized one-commit public snapshot before creating a public remote |
| Licence | MIT is declared in `LICENSE` and package metadata | Contribution and history rights still require owner confirmation |
| Automated tests | 1,685 tests pass across 59 suites locally on Node 26 on 2026-07-15; the earlier Node 24 baseline predates the latest feature batch | Re-run the exact candidate on supported Node 24 before release |
| Audio verification | Edge, Kokoro, and Chatterbox calibration fixtures pass | Preserve all three engine paths and verify fixture rights |
| Browser smoke | Playback, search, PWA, offline, and Range handling pass | Run in every release candidate workflow |
| Dependency audit | Production audit reports zero known vulnerabilities | Re-run at the signed release tag |
| Node versions | Native, CI, and container builds target Node.js 24 | Keep the supported major and declared range aligned; container bases remain digest-pinned |
| Authentication | Optional shared token protects all private API reads and writes through signed sessions or bearer auth | Keep trusted-LAN mode explicit and private by network policy |
| Network defaults | Native and host ports bind localhost; containers listen internally; CORS is allowlisted | Operators choose and secure any broader exposure |
| Configuration | `.env.template` matches implemented provider, auth, CORS, and rate-limit controls | Review it for every release |
| Containers | Hardened multi-stage image and restricted build context are present | Release workflow must pass both-architecture runtime and scan gates |
| Releases | Version declarations target `v1.1.0`; signed-tag workflow creates checksummed release artifacts | External release approvals and public infrastructure remain pending |
| TTS | Local Kokoro and Chatterbox exist; container packaging disables their auto-start and defaults to Edge | Document packaging capabilities and outbound data accurately |
| Acquisition | Anna's Archive, Z-Library, Gutenberg, Internet Archive, Standard Ebooks, OPDS, and upload paths exist | Preserve them; add provider status, provenance, and operator controls |
| Project files | Security, contribution, support, conduct, governance, privacy, legal, threat-model, and generated third-party notices are implemented | `xandrio.xyz` mail DNS and delivery must work before the published contacts are usable |

## 5. Decision map

### #1: What is the operating model?

Blocked by: none
Type: Discuss

#### Question

Does Xandrio operate a service for users, or does each operator run an independent server?

#### Answer

Resolved. Each operator runs an independent self-hosted server. Project infrastructure distributes source and packages only.

### #2: May release preparation remove functionality?

Blocked by: none
Type: Discuss

#### Question

May release work delete a provider, engine, import path, or product feature to reduce release risk?

#### Answer

Resolved: no. Preserve functionality. Escalate any claimed necessity for explicit review.

### #3: What is the first public version?

Blocked by: #1, #2
Type: Discuss

#### Question

Should the public release use `v1.0.0`, or should it advance because a `1.0.0` image and manifest already exist?

#### Answer

Resolved. The first public candidate is `v1.1.0`; release consistency checks enforce that version across package and Umbrel declarations.

### #4: Are all bundled code and assets redistributable?

Blocked by: #2
Type: Research

#### Question

Do contributor rights and third-party licences cover the application code, Inter font, icons, screenshots, calibration audio, model integrations, and other bundled files?

#### Answer

Partly resolved. Dependency notices and the asset inventory exist. The Inter font, all Xandrio icon variants, Umbrel icon use, and embedded TTS comparison assets are cleared. One standalone benchmark/reference-audio group remains blocked for owner provenance review in `docs/ASSET_PROVENANCE.md`; the release gate fails until it is cleared or handled under an approved plan.

### #5: What disclosures or controls do provider and TTS integrations require?

Blocked by: #1, #2
Type: Research

#### Question

What documentation, operator acknowledgement, opt-in state, terms review, or implementation change is required for each acquisition provider, Edge TTS, voice cloning, and outbound metadata service?

#### Answer

Implemented in software and documentation. Provider status labels, provenance, per-instance acknowledgement, Edge disclosure, and voice-reference authority confirmation preserve every capability. Targeted counsel review remains an external release approval.

### #6: Does repository history need sanitization?

Blocked by: #4
Type: Research

#### Question

Does the full Git history contain credentials, personal data, copyrighted books/audio, large generated files, or private operational material?

#### Answer

Blocked on owner action. The checksum-pinned full-ref scan finds four occurrences of one historical Anna credential after excluding one exact synthetic test fixture. The provider does not offer a replacement or revocation control. Automated one-commit public-root preparation and scanning are implemented and tested, but cannot pass the remaining source gates yet. The legacy repository must remain private; create the public repository from the sanitized root only after explicit approval. Do not rewrite, force-push, or change the legacy repository visibility.

## 6. Work plan

### Phase 0 — Establish the release snapshot

Priority: P0
Blocked by: none

Tasks:

- Review the current dirty worktree and divide it into intentional commits without discarding unrelated work.
- Create a release-preparation branch after the current feature work is committed.
- Record the baseline feature matrix: all providers, imports, engines, voice cloning, playback modes, offline storage, sync, deletion, and packaging paths.
- Record the baseline test results: 1,685 tests across 59 suites, calibrated audio verification, and browser smoke; repeat them on Node 24 for the candidate.
- Decide #3, the first public version.
- Add an `[Unreleased]` changelog section covering every change since `0.2.0`.
- Define release-blocking labels: `release-blocker`, `security`, `licensing`, `legal-review`, `packaging`, and `documentation`.

Acceptance criteria:

- The release branch has a clean worktree.
- Every existing feature appears in the release feature matrix.
- Each current modification belongs to a reviewed commit.
- Version, changelog, package metadata, container tags, and Umbrel metadata can be updated from one source.

### Phase 1 — Verify ownership, licensing, and repository history

Priority: P0
Blocked by: Phase 0; decisions #4 and #6

Tasks:

- Confirm that the project may publish every historical code contribution under MIT.
- Decide whether future contributions use a Developer Certificate of Origin or a contributor licence agreement. Prefer a DCO unless a separate rights-assignment need exists.
- Add `license`, `repository`, `bugs`, `homepage`, supported Node version, and package-description fields to `package.json`.
- Inventory direct and transitive Node licences and generate `THIRD_PARTY_NOTICES.md`.
- Create pinned Python dependency manifests for Kokoro and Chatterbox and inventory their package and model licences.
- Record provenance and redistribution terms for:
  - `public/fonts/inter-latin.woff2`;
  - application and Umbrel icons;
  - screenshots and promotional images;
  - Edge, Kokoro, and Chatterbox calibration samples;
  - any bundled or documented voice-reference samples;
  - OCR, Poppler, ffmpeg, Playwright/Chromium, and container-base components.
- Ensure user-created voice references, books, covers, generated audio, local screenshots, and test output are untracked and excluded from packages.
- Run a full-history secret scan and a full-history large/binary-file inventory.
- Rotate any credential found in history, logs, examples, or release configuration.
- If sanitization is required, prepare a history-rewrite proposal with affected clones, tags, and packages; execute it only after approval.
- Add `CONTRIBUTING.md`, DCO instructions if selected, `CODE_OF_CONDUCT.md`, and a contribution review checklist covering licences and generated assets.

Acceptance criteria:

- Every shipped binary asset has recorded provenance and redistribution terms.
- All dependency ecosystems have machine-readable manifests and human-readable notices.
- The full history passes the selected secret scanner.
- No private data directory, credentials file, generated book/audio file, or operator log is tracked or included in a release archive.
- Decision #4 and #6 have recorded answers.

### Phase 2 — Establish legal-use and data-flow documentation

Priority: P0
Blocked by: Phase 1; decision #5

Tasks:

- Add a concise `LEGAL-NOTICE.md` stating:
  - Xandrio is self-hosted software, not a content provider;
  - operators control their server, sources, credentials, books, and generated playback caches;
  - operators must have a lawful basis to access and process content under applicable law and agreements;
  - the project does not determine copyright or public-domain status worldwide;
  - generated playback audio is intended for private use unless the operator has broader rights;
  - the notice is informational and not jurisdiction-specific legal advice.
- Add the same short notice to the README and first-run experience.
- Preserve all acquisition providers while assigning each a visible status:
  - `operator upload`;
  - `rights metadata available`;
  - `rights status unverified`;
  - `operator-configured catalog`.
- Require explicit per-instance enablement and acknowledgement for providers whose results do not carry reliable rights metadata.
- Keep the acknowledgement outside the MIT licence and avoid claiming that it immunizes the project or operator.
- Preserve source provenance on every imported book: provider, provider item identifier, source URL/domain, acquisition time, and reported rights/licence metadata when available.
- Add provider-specific notices covering account requirements, credential storage, upstream availability, rate limits, and independent provider terms.
- Review the Anna Playwright/stealth fallback and its current protection-bypass description. The review may approve it, require clearer opt-in/wording, or propose an equivalent supported access path. It may not remove the capability without a separate approval.
- Document Edge as an unofficial consumer-endpoint integration unless Microsoft confirms a supported third-party path.
- Disclose that Edge sends narration text to Microsoft; local Kokoro and Chatterbox keep narration on the operator's configured host.
- Add an official Azure Speech provider proposal as an additional supported cloud path without replacing Edge.
- Add voice-cloning acknowledgement requiring the operator to confirm authority to use the submitted voice sample.
- Document that Xandrio stores playback caches for reuse and offline playback but does not provide a social-sharing or audiobook-publishing feature.
- Create a data-flow table for every outbound service: data sent, purpose, credential type, storage location, retention under Xandrio's control, and disablement method.
- Obtain targeted counsel review for the distribution jurisdictions chosen by the project owner. Ask about distribution and promotion of the connectors, not each end user's ultimate legal conclusion.

Acceptance criteria:

- An operator can identify every outbound network destination before enabling it.
- Provider results communicate whether rights metadata is known, unknown, or operator-supplied.
- No documentation promises worldwide legality.
- Every existing provider and TTS engine remains usable.
- Decision #5 records the accepted disclosures and controls for each integration.

### Phase 3 — Harden self-hosted access and privacy

Priority: P0
Blocked by: Phase 0

Tasks:

- Write a threat model for four supported deployments: localhost, trusted LAN, Tailscale/private tunnel, and Umbrel reverse proxy.
- Separate public routes from private-instance routes. Keep static assets and `/health` public; require instance authorization for library metadata, book content, audio, credentials, preferences, bookmarks, stats, and sync data when authentication is configured.
- Replace the current mutation-only token behavior with a complete documented authentication flow that works with `<audio>`, service workers, Range requests, and offline caching.
- Have the server set authentication cookies with appropriate `HttpOnly`, `SameSite`, path, expiry, and `Secure` behavior instead of relying only on client-written long-lived cookies.
- Keep a documented trusted-LAN mode if desired, but show a prominent warning and never imply that `0.0.0.0` is private by itself.
- Implement the documented `CORS_ORIGIN`, `RATE_LIMIT_WINDOW`, and `RATE_LIMIT_MAX` controls or remove those inactive variables from the template after explicit review. Do not leave configuration that has no effect.
- Restrict CORS to configured origins and support the Umbrel/reverse-proxy origin explicitly.
- Add baseline response headers: content-type protection, frame policy, referrer policy, and a tested Content Security Policy.
- Apply rate limits and concurrency limits to authentication, search, download, upload, OCR, metadata refresh, TTS generation, and voice-upload routes.
- Recheck upload limits, archive expansion limits, PDF/OCR resource limits, and cleanup after interrupted uploads.
- Apply consistent SSRF, redirect, DNS-rebinding, timeout, and response-size controls to every remote provider and cover fetch, building on the hardened Z-Library path.
- Define permissions and redaction requirements for stored provider tokens, pairing codes, voice samples, settings, logs, and error responses.
- Add backup, restore, export, and complete-delete documentation for `data/`, `cache/`, browser offline storage, and custom voice references.
- Add tests proving that one unauthorized network client cannot list a configured instance's library or retrieve its audio.
- Add tests for CORS, cookies, proxy headers, Range requests under auth, rate limits, upload aborts, and secret redaction.

Acceptance criteria:

- The documented deployment modes match actual route exposure.
- A protected instance requires authorization for all private data, including GET audio and library routes.
- Offline playback and Range requests still work under authentication.
- Every environment variable in `.env.template` is implemented and tested or deliberately removed from the template without removing functionality.
- Security tests run in CI.

### Phase 4 — Resolve dependency and supply-chain risk

Priority: P0
Blocked by: Phase 1

Tasks:

- Triage each current production audit finding by reachable code path and fixed version.
- Upgrade Express/body-parser and their routing/query dependencies without changing the API contract.
- Upgrade Multer or add compensating upload controls for every reported resource-exhaustion path.
- Review replacement or maintained-fork options for the old `epub` dependency chain containing `zipfile`, `node-pre-gyp`, `tar`, `xml2js`, and related findings. Any replacement must retain EPUB import behavior and pass the feature matrix.
- Update the WebSocket dependency used by Edge TTS to a fixed version or document why the vulnerable path is unreachable pending an upstream fix.
- Add regression fixtures for every dependency-driven parser or upload change.
- Set a release policy: no known critical vulnerability; no unreviewed high vulnerability; every accepted moderate/low finding has an owner, reachability note, and review date.
- Add Dependabot or Renovate for npm, GitHub Actions, Docker, and Python manifests.
- Pin GitHub Actions to reviewed commit SHAs.
- Pin container base images by digest and define a scheduled rebuild policy for OS security updates.
- Generate CycloneDX or SPDX SBOMs for the source package and each container image.
- Add dependency review, CodeQL, secret scanning, and container scanning to CI.
- Sign release images and attach build provenance/attestations where supported.

Acceptance criteria:

- `npm audit --omit=dev` meets the release policy.
- No high finding is silently waived.
- Parser, provider, upload, TTS, and playback regression tests remain green.
- Published images have an SBOM, vulnerability report, immutable digest, and signature/provenance record.

### Phase 5 — Make packaging reproducible and private-data-safe

Priority: P0
Blocked by: Phases 1, 3, and 4

Tasks:

- Add `.dockerignore` before the next image build. Exclude `.git`, `.env*`, `data/`, `cache/`, worktrees, virtual environments, logs, output/screenshots, local certificates, books, generated audio, and developer-tool state while retaining required public assets and test fixtures.
- Verify the Docker build context contains no operator data or secret.
- Select one supported Node major and align `package.json`, README, CI, Docker, and development documentation.
- Add reproducible Python installation instructions and separate optional local-engine images or Compose profiles for Kokoro and Chatterbox. Preserve Edge-only lightweight deployment.
- Document CPU, memory, disk, architecture, OCR, and local-model requirements.
- Add container health checks and graceful shutdown verification.
- Run the production container as a non-root user with writable paths limited to documented volumes and temporary directories.
- Verify clean first-run directory ownership for plain Docker, Compose, and Umbrel.
- Replace hard-coded image versions with release-workflow inputs derived from the Git tag.
- Build the image once, test that exact digest, then promote the same digest to version and stable tags.
- Update the Umbrel manifest and Compose file from the verified multi-architecture digest.
- Test anonymous GHCR pull before publishing the Umbrel manifest.
- Create upgrade and rollback tests that preserve library metadata, source credentials, playback positions, cached audio, extracted artifacts, bookmarks, users, and voice references.
- Generate checksums for non-container release archives.

Acceptance criteria:

- A clean checkout produces the same application artifacts from documented commands.
- Docker build context inspection finds no local secret or operator content.
- Both architectures start, pass `/health`, import a fixture, generate/play audio, and preserve data across restart.
- Umbrel installs the exact tested digest anonymously.
- Upgrade and rollback procedures preserve all documented persistent data.

### Phase 6 — Rewrite public documentation around self-hosting

Priority: P1
Blocked by: Phases 2, 3, and 5

Tasks:

- Rewrite the README opening to state that Xandrio is a self-hosted personal reading server.
- Explain that the operator, not the project, hosts the server and controls its library and providers.
- Provide separate quick starts for native Node, Docker Compose, Umbrel, and private remote access through Tailscale or another reverse proxy.
- Correct current documentation drift, including:
  - clone directory and repository URL;
  - optional versus required provider credentials;
  - supported import formats;
  - all current providers and TTS engines;
  - API endpoint counts;
  - current frontend files and architecture;
  - missing or stale screenshot references;
  - Node and system dependency versions;
  - cache and source-file retention behavior;
  - container limitations for local engines.
- Replace “DDoS-Guard bypass” marketing language with accurate implementation and operator-risk documentation based on the Phase 2 review.
- Document provider configuration, health states, credentials, source provenance, and operator enablement.
- Document Edge's unsupported status, outbound text flow, expected breakage risk, and local/official-cloud alternatives.
- Document voice-cloning consent expectations and private storage behavior.
- Add a security deployment guide covering LAN exposure, authentication, TLS, reverse proxies, Tailscale, backups, and updates.
- Add a privacy/data-flow document with an outbound endpoint matrix.
- Update `docs/API.md`, `docs/ARCHITECTURE.md`, `PRODUCT.md`, Umbrel docs, changelog, and in-product help to agree.
- Add troubleshooting for provider outages, local-engine health, browser offline storage, OCR, architecture compatibility, and migration.

Acceptance criteria:

- A new operator can install without relying on undocumented project knowledge.
- Every documented command succeeds from a clean checkout.
- Documentation contains no hosted-service implication and no unsupported legal guarantee.
- All docs describe the same provider, engine, storage, security, and version behavior.

### Phase 7 — Establish public-project governance

Priority: P1
Blocked by: Phase 1

Tasks:

- Add `SECURITY.md` with supported versions, private reporting channel, response expectations, and disclosure process.
- Add `SUPPORT.md` separating bugs, security reports, provider outages, and jurisdiction-specific legal questions.
- Add issue forms for bugs, features, provider failures, security redirection, and documentation.
- Add a pull-request template with tests, migration impact, licence/provenance, privacy, security, and functionality-preservation checks.
- Add `CODEOWNERS` for release workflows, auth/security, providers, TTS engines, packaging, and legal notices.
- Define maintainer roles, merge requirements, release authority, and provider-maintenance expectations.
- Enable branch protection after the repository becomes public: required CI, reviewed pull requests, no force pushes, no tag deletion, and restricted release workflows.
- Define a deprecation policy. A future removal still requires an announced proposal, migration path, and project-owner approval.

Acceptance criteria:

- Contributors know how to report, test, license, and document changes.
- Security reports have a non-public path.
- Release-sensitive files require review.
- Governance explicitly preserves the no-silent-removal rule.

### Phase 8 — Build the release-candidate gate

Priority: P0
Blocked by: Phases 1–7

Tasks:

- Create a release workflow that rejects a tag when package, changelog, container, Umbrel, service-worker, and release versions disagree.
- Run static syntax checks and the complete test suite (currently 1,402 tests across 53 suites).
- Run calibrated audio verification for Edge, Kokoro, and Chatterbox.
- Run browser smoke tests on Chromium and a focused Safari/iOS manual matrix.
- Test all acquisition paths:
  - upload;
  - Anna API/CLI and Playwright fallback;
  - Z-Library anonymous search, login, download, expiry, and disconnect;
  - Gutenberg;
  - Internet Archive;
  - Standard Ebooks;
  - generic OPDS.
- Test EPUB, MOBI, AZW3/Kindle, text PDF, and scanned PDF/OCR imports.
- Test Edge, Kokoro, Chatterbox, custom voice, engine outage/recovery, voice changes, and cache invalidation.
- Test playback, seeking, chapter transitions, speed, sleep timer, bookmarks, pronunciations, stats, sync/pairing, offline download/delete, and complete book deletion.
- Test clean install and upgrade on `linux/amd64` and `linux/arm64`.
- Test localhost, LAN, Tailscale/reverse proxy, and Umbrel access modes.
- Verify that disabling or leaving a provider unconfigured does not break upload or other providers.
- Run full-history secret scan, dependency audit, SBOM generation, container scan, licence check, and build-context inspection.
- Produce a release-candidate report with every gate result, accepted risk, owner, and review date.

Acceptance criteria:

- No feature in the Phase 0 matrix is missing or silently disabled.
- All P0 gates pass or have an explicit, recorded owner decision.
- The release candidate is the exact commit and image digest intended for publication.
- Rollback has been exercised, not merely documented.

### Phase 9 — Publish

Priority: P0
Blocked by: Phase 8

Tasks:

- Freeze merges except release blockers.
- Re-run the release-candidate workflow from the final commit.
- Confirm that repository history and release archives contain no secret, private data, or unlicensed asset.
- Change GitHub repository visibility to public.
- Enable repository security features and branch protection.
- Push the signed version tag.
- Publish the GitHub release, source archives, checksums, SBOMs, and attestations.
- Publish the already-tested GHCR digest and make the package anonymously readable.
- Update and publish the digest-pinned Umbrel entry.
- Verify from logged-out, clean environments:
  - anonymous clone;
  - licence visibility;
  - release archive download and checksum;
  - GHCR pull for both architectures;
  - Docker Compose install;
  - Umbrel install;
  - first-run acknowledgement and authentication;
  - one upload, one provider search, and one TTS playback.
- Publish release notes with known limitations, security posture, provider dependencies, Edge status, local-engine requirements, and upgrade instructions.

Acceptance criteria:

- Every public artifact resolves to the approved release commit or image digest.
- Anonymous installation succeeds by every supported path.
- No project-operated content, credential, or TTS service is introduced by publication.
- Support and private security-reporting channels work.

### Phase 10 — Operate the public release

Priority: P1
Blocked by: Phase 9

Tasks:

- Monitor installation failures, provider breakage, dependency advisories, image vulnerabilities, and security reports.
- Rebuild images on a fixed cadence for base-image and browser updates even when application code is unchanged.
- Publish provider compatibility status without making jurisdiction-wide legal claims.
- Review accepted security and licensing risks on their recorded dates.
- Maintain supported-version and migration policies.
- Run a post-release review after the first stable operator cohort and convert findings into versioned issues.

Acceptance criteria:

- Every supported release has a current image and security status.
- Provider outages are distinguishable from Xandrio defects.
- Accepted risks do not remain open without an owner or review date.

## 7. Explicit owner-review gates

Stop and request an explicit decision before taking any of these actions:

1. Removing or permanently disabling any existing feature.
2. Replacing a provider or TTS implementation when behavior, quality, or access may change materially.
3. Rewriting Git history.
4. Publishing an asset whose provenance or redistribution right remains unclear.
5. Accepting a reachable high-severity vulnerability into the public release.
6. Publishing an integration after qualified review concludes that distribution creates material project risk.
7. Changing the software licence or adding a field-of-use restriction.
8. Operating any hosted proxy, account, catalog, credential, content, or TTS service for users.

## 8. Critical path

The shortest responsible path to publication is:

1. Commit and stabilize the current feature set.
2. Add `.dockerignore` and verify that no local data enters build artifacts.
3. Complete provenance, history, and dependency audits.
4. Resolve authentication and private GET-route exposure for networked self-hosting.
5. Complete provider/TTS disclosures and explicit per-instance enablement without removing integrations.
6. Align versions and make the image workflow reproducible.
7. Rewrite installation, security, legal-use, and data-flow documentation.
8. Run the complete release-candidate matrix on both architectures.
9. Publish one tested commit and image digest across GitHub, GHCR, and Umbrel.

## 9. Release approval checklist

- [ ] Current worktree is committed and reviewed.
- [ ] Every existing feature is represented in the release matrix.
- [ ] Decisions #3–#6 are resolved.
- [ ] Full-history secret and asset scans pass.
- [ ] Third-party notices and asset provenance are complete.
- [ ] Legal-use, provider, Edge, voice, and data-flow notices are published.
- [ ] Private-instance GET routes are protected in authenticated deployments.
- [ ] CORS, rate limits, cookies, uploads, SSRF controls, and secret storage are tested.
- [ ] Production dependency findings meet the release policy.
- [ ] `.dockerignore` and build-context inspection pass.
- [ ] Node, Python, Docker, CI, and documentation versions agree.
- [ ] Version and digest references agree across all release files.
- [ ] Unit/integration, audio, browser, provider, format, engine, security, upgrade, and rollback tests pass.
- [ ] AMD64 and ARM64 images are tested and anonymously pullable.
- [ ] GitHub governance and private security reporting are ready.
- [ ] Final release candidate report is approved.
- [ ] No functionality was removed without explicit approval.
