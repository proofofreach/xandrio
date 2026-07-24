# Periodic release-risk review

Status: first review due before the v1.1.0 tag. Thereafter review monthly and
within 72 hours of a critical advisory, exposed credential, provider terms
change, or material outage.

| Review area | Cadence | Evidence to inspect | Accountable owner | Current status |
| --- | --- | --- | --- | --- |
| OCI and dependency vulnerabilities | Monthly; critical within 72 hours | Exact-digest scan, `npm audit`, SBOM, base-image advisories | Security maintainer | Initial review pending |
| Repository secrets and asset rights | Before every tag; quarterly otherwise | Full-history scan, `ASSET_PROVENANCE.md`, contributor evidence | Security and project owners | Initial review pending |
| Providers and narration engines | Monthly and after upstream change | `PROVIDER_COMPATIBILITY.md`, live checks, terms/region changes, incidents | Provider and TTS maintainers | Initial review pending |
| Privacy and operator controls | Quarterly and before material data-flow change | Privacy notice, logs/redaction, backups, deletion, auth defaults | Security maintainer | Initial review pending |
| Packaging and recovery | Every release; quarterly restore drill | Docker, Umbrel, FIRST-01/DATA-02 evidence, backup checksum and restore log | Packaging maintainer | Initial review pending |
| Governance and release authority | Quarterly | Protected branch/environment, CODEOWNERS, signing and package visibility | Project owner | Initial review pending |

Each review produces a dated issue or report with attendees, findings, decisions,
owners, and due dates. An overdue item remains open; it is not implicitly
accepted.
