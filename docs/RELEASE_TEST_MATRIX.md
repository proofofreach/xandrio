# Release test matrix

Release: v1.1.0
Status: blocked — no candidate has satisfied this matrix
Rule: every `Blocking` row must be `Pass` with dated, immutable evidence before the protected release environment is approved. Source/legal/history approvals pass before the signed tag; candidate and exact-digest results necessarily pass after the tag builds the immutable candidate. `Not run`, `Blocked`, `Waived`, or a generic workflow claim fails promotion.

Evidence may be a GitHub Actions run URL and job/step name, a retained artifact
path and checksum, or a dated manual-test recording with device and browser
version. Do not place credentials, book text, screenshots containing private
libraries, or provider responses in the evidence link.

These are tagged gate definitions, not pre-populated result claims. The
workflow-generated `CANDIDATE_EVIDENCE.md` records automatic results without
modifying the signed tag. Protected-environment reviewers must link the
remaining dated evidence in their approval before promotion.

| ID | Scope | Release gate | Method and acceptance criteria | Status | Evidence | Owner | Recorded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SRC-01 | Blocking | Source integrity | Signed tag resolves to the candidate commit; release declarations, full-history secret scan, asset review, licence notices, SBOMs, production audit, tests, and calibrated audio pass. | Not run | Pending candidate workflow URL and artifacts | Release owner | Pending |
| OCI-01 | Blocking | amd64 OCI image | Exact digest starts, reports healthy, imports the smoke EPUB, generates playable audio, and serves a 32-byte HTTP Range response. | Not run | Pending candidate run, image digest, and logs | Release owner | Pending |
| OCI-02 | Blocking | arm64 OCI image | Same checks as OCI-01 on `linux/arm64`; native or emulated execution is stated in the evidence. | Not run | Pending candidate run, image digest, and logs | Release owner | Pending |
| OCI-03 | Blocking | Image security and provenance | Exact multi-architecture digest has a passing HIGH/CRITICAL scan, SBOM/provenance attestation, OIDC signature, and anonymous pull after package publication. | Not run | Pending digest, scan, attestation, signature, and pull transcript | Security maintainer | Pending |
| DATA-01 | Blocking | Restart persistence | Books, extracted artifacts, generated audio, settings, positions, bookmarks, users, provider state, and voice references survive a candidate restart without content or checksum drift. | Not run | Pending candidate artifact and checksum log | Packaging maintainer | Pending |
| DATA-02 | Blocking | Upgrade and rollback | Previous stable → candidate → previous stable retains the DATA-01 fixture. If no prior stable exists, run FIRST-01 instead; this row is then `Not applicable` with a link to FIRST-01. | Not run | Pending workflow artifact | Packaging maintainer | Pending |
| FIRST-01 | Blocking | First-release backup and restore | Before the first public promotion, create a versioned, checksummed backup of data and cache fixtures; restore it into a clean named volume; start the candidate; verify DATA-01; then restore the untouched pre-test backup again. | Not run | Pending backup manifest, checksums, restore log, and candidate digest | Release owner | Pending |
| BROW-01 | Blocking | Chromium regression | Supported Chromium browser passes upload, narration, Range seek, offline shell, queue, bookmark, speed, sleep timer, and auth paths. | Not run | Pending CI run and Playwright report | QA owner | Pending |
| IOS-01 | Blocking | Safari on iOS | Physical supported iPhone/iPad Safari plays a generated chapter, seeks through a Range request, locks/unlocks, resumes, uses the sleep timer, and installs/opens the PWA if offered. Record device, iOS, Safari version, network, and result. | Blocked | Manual device evidence required | QA owner | Pending |
| LAN-01 | Blocking | LAN exposure | A non-host client reaches the instance through the documented LAN address; configured auth/CORS behavior is correct; no container port is accidentally public beyond the chosen interface. | Blocked | Manual second-device evidence required | Deployment owner | Pending |
| NET-01 | Blocking | Tailscale or reverse proxy | For each supported remote route used in release guidance, validate TLS, WebSocket/streaming behavior if enabled, auth forwarding, client IP/rate-limit behavior, large upload, audio Range seek, and no mixed-content error. State Tailscale, proxy product, or both. | Blocked | Manual deployment evidence required | Deployment owner | Pending |
| UMB-01 | Blocking | Umbrel install and upgrade | A clean Umbrel host installs the digest-pinned artifact from anonymous GHCR; health, upload, playback, persistent restart, and uninstall-data warning pass. Record Umbrel version and device architecture. | Blocked | Manual Umbrel evidence required | Umbrel maintainer | Pending |
| FMT-01 | Blocking | EPUB | Upload/import, metadata, chapters, narration, seek, and delete pass with a lawful smoke fixture. | Not run | Pending automated or manual run | Import maintainer | Pending |
| FMT-02 | Blocking | PDF | Text extraction/import, chapters, narration, seek, and delete pass with a lawful fixture; record any OCR limitation separately. | Not run | Pending automated or manual run | Import maintainer | Pending |
| FMT-03 | Blocking | MOBI, PRC, AZW, AZW3 | Each retained Kindle-family extension imports or produces a documented supported failure; no format silently disappears. | Not run | Pending fixtures and run log | Import maintainer | Pending |
| TTS-01 | Blocking | Microsoft Edge | Live disposable request produces playable cached audio; disabled or failed Edge does not break local engines or upload. Record endpoint status without publishing text or credentials. | Blocked | Live-provider evidence required | TTS maintainer | Pending |
| TTS-02 | Blocking | Local Kokoro | Current pinned image starts on every architecture documented as supported for that image, produces playable audio, and remains private to the Compose network. | Not run | Pending image/run evidence | TTS maintainer | Pending |
| TTS-03 | Blocking | Local Chatterbox | Current pinned image starts on every architecture documented as supported for that image, produces playable audio, and remains private to the Compose network. | Not run | Pending image/run evidence | TTS maintainer | Pending |
| PROV-01 | Blocking | Public catalogue providers | Standard Ebooks, Gutenberg, Internet Archive, and OPDS show configured health/failure state; one lawful query per provider succeeds or a documented upstream outage is accepted by the project owner. | Blocked | Live-provider evidence required | Provider maintainer | Pending |
| PROV-02 | Blocking | Account/unverified-rights providers | Anna's Archive and Z-Library remain opt-in, acknowledgement-gated, credential-redacted, and isolated from other sources. Live checks require owner/counsel approval and must not use a shared credential. | Blocked | Legal and live-provider evidence required | Provider and project owners | Pending |
| SEC-01 | Blocking | Privacy and operator controls | Auth, pairing, CORS, rate limits, SSRF controls, logs/redaction, provider acknowledgement, backup, restore, and full delete behavior match public documentation. | Not run | Pending security review and evidence | Security maintainer | Pending |

`Not applicable` requires an evidence link and written reason. A waiver requires
project-owner approval in `docs/RELEASE_APPROVALS.md`; it cannot waive legal,
security, asset-provenance, signed-tag, or first-release backup/restore gates.
