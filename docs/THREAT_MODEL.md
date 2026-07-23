# Threat model

Xandrio is a self-hosted personal reading server. Project infrastructure ships
source and packages; it does not proxy operator books, credentials, provider
traffic, narration text, or generated audio.

## Protected assets

- book files, extracted text, covers, library metadata, positions, bookmarks,
  listening statistics, and cached narration;
- provider keys and sessions, instance authentication material, pairing codes,
  and settings;
- custom voice references and generated voice audio;
- host filesystem integrity and the availability of CPU, memory, disk, network,
  OCR, browser, and narration processes.

Static application assets and `/health` are intentionally public. When
`XANDRIO_TOKEN` is configured, every `/api` route—including library metadata,
book content, audio, Range requests, settings, and sync—is private. Without the
token, the operator has explicitly selected trusted-LAN mode and every client
that can reach the port is trusted.

## Deployment boundaries

| Mode | Trust boundary | Main risk | Required controls |
| --- | --- | --- | --- |
| Localhost | One host account and local browser | Other local accounts, malicious files, provider responses | Bind to loopback, protect the host account and data directory, keep parsers updated |
| Trusted LAN | Every device able to reach port 8181 | Untrusted guest/IoT clients reading the library or exhausting work queues | Prefer `XANDRIO_TOKEN`; otherwise isolate the LAN and do not expose the port beyond it |
| Tailscale/private tunnel | Tailnet identity and ACLs plus Xandrio | Over-broad ACLs, shared devices, incorrect Serve configuration | Bind upstream privately, require tailnet identity/ACLs, use HTTPS, test from an unauthorized identity |
| Umbrel/reverse proxy | Proxy, TLS boundary, origin forwarding, and Xandrio session | Public exposure, spoofed proxy headers, wrong CORS origin, anonymous image/package access | Set `XANDRIO_TOKEN`, TLS, exact `CORS_ORIGIN`, and the minimum `XANDRIO_TRUST_PROXY`; test cookie and Range playback through the proxy |

## Principal abuse cases and mitigations

| Abuse case | Mitigation / residual risk |
| --- | --- |
| Unauthorized library or audio access | Signed `HttpOnly`, `SameSite=Lax` sessions and bearer support protect all API routes when configured. TLS remains the operator's responsibility. |
| Cross-origin requests or framing | Exact CORS allowlist, CSP, frame denial, content-type protection, and referrer policy. Same-host malicious browser extensions remain outside Xandrio's control. |
| Password/token guessing and resource exhaustion | Bounded route-group rate limits, upload limits, provider timeouts, import job limits, and TTS scheduling. A trusted authenticated operator can still exhaust their own host. |
| Malicious book/archive/parser input | Format checks, validation, extraction limits, temporary-file cleanup, and isolated external tools where available. Parser defects remain possible; keep dependencies and system tools updated. |
| Provider redirects, signed URLs, and hostile metadata | Provider-specific URL validation, bounded redirects/timeouts/response sizes, output sanitization, and safe public errors. Operators choose and trust enabled providers. |
| Secret disclosure in APIs or logs | Private API routes, redacted provider errors, token-only Z-Library storage, `0600` JSON/voice-reference writes, and release history scanning. Existing files should be permission-audited after upgrade. |
| Voice misuse | Upload requires explicit authority/consent confirmation; references stay on the instance. Confirmation is a product control, not proof of consent. |
| Copyright or provider-terms misuse | Unverified sources are disabled until per-instance acknowledgement and enablement; results and imports retain rights-status/provenance labels. Xandrio does not decide worldwide legality. |
| Supply-chain replacement | Locked dependencies, pinned CI actions/base image, SBOMs, CodeQL/dependency review, image scanning, OIDC signing, and digest-only Umbrel promotion. |

## Operator verification

Before exposure, test `/api/library` and an audio Range request from an
unauthorized client, verify the browser receives a secure session through the
proxy, inspect permissions on `data/` and voice references, and confirm backups
are encrypted and access-controlled. See [SELF_HOSTING.md](SELF_HOSTING.md) and
[SECURITY.md](../SECURITY.md) for deployment and reporting guidance.
