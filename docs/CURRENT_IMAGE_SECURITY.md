# Current image security record

Status: blocked — no public v1.1.0 OCI digest exists. Do not claim that a
current image is scanned, signed, or safe until this record identifies the
exact multi-architecture digest.

| Field | Required release evidence | Current value |
| --- | --- | --- |
| Image and digest | `ghcr.io/proofofreach/alexandrio@sha256:<64 lowercase hex>` | Pending candidate build |
| Platforms | Manifest proves `linux/amd64` and `linux/arm64` | Pending candidate build |
| Build inputs | Signed tag, commit SHA, build timestamp, Dockerfile checksum | Pending candidate build |
| Vulnerability scan | Exact digest; HIGH/CRITICAL policy, scanner version, result, report URL | Pending candidate build |
| SBOM and provenance | Downloadable attestations bound to the exact digest | Pending candidate build |
| Signature | OIDC identity, verification command, and result | Pending candidate build |
| Public pull | Logged-out exact-digest pull transcript | Pending package visibility check |
| Base image review | Base digest, upstream support state, and reviewer decision | Pending candidate build |

The release owner must copy completed values into the candidate evidence report.
If a scan has a known exception, record its advisory, severity, exploitability,
mitigation, named approver, and expiry in `ACCEPTED_RISKS.md`; do not replace
the scan result with a blanket statement.
