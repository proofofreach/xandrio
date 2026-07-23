# Security Policy

## Supported versions

Security fixes are made on the latest released version. Older versions may receive guidance, but are not guaranteed fixes.

## Report a vulnerability

Do not open a public issue for a vulnerability. Email the project maintainers at **security@xandrio.xyz**.

Include affected version, reproduction steps, impact, and any proof of concept. Do not include real credentials, books, voice samples, or generated audio.

We aim to acknowledge reports within seven days, provide a status update within 14 days, and coordinate disclosure after a fix or mitigation is available. These are targets, not guarantees.

## Deployment baseline

Treat a Xandrio instance as private. Use localhost, a trusted LAN, or a private tunnel such as Tailscale. If the instance is exposed through a reverse proxy, configure TLS and authentication, keep the server updated, and restrict access to people who may read the library and audio cache. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

The supported deployment boundaries, protected assets, abuse cases, and
verification steps are recorded in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
