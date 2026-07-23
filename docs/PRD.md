# Xandrio Product Requirements

## Purpose

Xandrio is an operator-hosted personal reading server. It imports readable book files, searches operator-selected sources, creates private narration, and provides mobile-first playback. The project distributes software; it does not host books, accounts, provider requests, or TTS for operators.

## Required capabilities

- Import EPUB, MOBI, AZW, AZW3, PRC, and PDF files.
- Preserve provider paths for Anna's Archive, Z-Library, Project Gutenberg, Internet Archive, Standard Ebooks, and operator-configured OPDS.
- Show provider availability and rights-status labels: operator upload, provider metadata, unverified, or operator-configured catalog.
- Require an explicit per-instance acknowledgement before a provider that lacks reliable rights metadata is enabled, without removing that provider or blocking other lawful paths.
- Preserve source provenance where supplied: provider, provider item identifier, source URL/domain, acquisition time, and reported rights/licence metadata.
- Provide Edge, Kokoro, and Chatterbox narration paths, cached playback, offline use, sync state, bookmarks, and deletion.
- Require operator authority for custom voice references and retain them only on the operator-controlled instance.

## Boundaries

- Do not claim that a source, work, or use is permitted or prohibited worldwide.
- Do not operate a project-hosted content, proxy, catalog, credential, account, or TTS service.
- Do not provide a social-sharing or audiobook-publishing feature.
- Do not remove or permanently disable an existing provider, import path, engine, or feature without explicit project-owner approval, an announced proposal, and a migration path.

## Operator experience

On first use, the operator acknowledges the instance boundary and legal-use responsibility. Settings shows provider configuration, availability, enablement, and rights-status information. Search lets the operator include or exclude available sources. A disabled or unconfigured provider must not break upload or other sources.

## Non-functional requirements

- Support private local, LAN, Tailscale/private-tunnel, reverse-proxy, Docker, and Umbrel deployments.
- Keep operator data in documented persistent storage and document backup, restore, retention, and complete deletion.
- Make every outbound destination and its disablement method discoverable.
- Treat Edge as an unofficial consumer-endpoint integration, disclose its outbound narration-text flow, and preserve local alternatives.

See [PRODUCT.md](../PRODUCT.md), [PRIVACY.md](PRIVACY.md), [SELF_HOSTING.md](SELF_HOSTING.md), and [GOVERNANCE.md](../GOVERNANCE.md).
